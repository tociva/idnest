# Auth Backend

The auth backend is the trusted service that orchestrates Hydra login, consent,
logout, Kratos sessions, client access checks, and delegated authorization token
brokering.

## Delegated authorization

Idnest can issue short-lived access tokens to a trusted service acting for a
user. The implementation is generic: Idnest knows OAuth client IDs, resource
audiences, scopes, opaque subjects, and opaque authorization-context
references. It does not store product names, organizations, installations,
roles, workflows, or agent state.

The responsibility boundary is:

- The resource application owns organization installation records, user
  membership, roles, business permissions, and workflow approval.
- Hydra authenticates the resource authorizer and actor as confidential
  `client_credentials` clients.
- Idnest binds one authorization decision to a resource, actor, subject,
  scopes, and optional opaque context; it then signs a short-lived token from a
  dedicated issuer.
- The resource API validates that token and still enforces current business
  authorization. A removed or suspended user should be checked live when
  immediate revocation is required.

This allows an organization owner to install a service once in the product.
Other eligible organization users do not install it again. Each invocation
still passes through the product's current user and organization authorization
before the product creates a one-time Idnest grant.

### Security flow

1. The product authenticates the user and checks the selected organization,
   installation, role, requested action, and any agent-specific approval.
2. The product backend obtains its Hydra service token with audience
   `urn:idnest:delegation` and scope `delegation.grant`.
3. It submits the opaque user subject, target actor client, resource, scopes,
   and an opaque installation or authorization reference to
   `POST /auth/v1/delegation/grants`.
4. Idnest verifies the service token through Hydra's private introspection API,
   checks the resource and actor policies, and returns a random one-time
   exchange token. Only its SHA-256 hash is stored.
5. The actor obtains its own Hydra service token with the same broker audience
   and scope `delegation.exchange`, then submits both tokens to
   `POST /auth/v1/delegation/token` using OAuth token-exchange fields.
6. Idnest atomically consumes the grant and returns a 30–300 second ES256
   bearer token. It has no refresh token. Replay, expiry, revocation, a wrong
   actor, or disabled policy produces `invalid_grant`.

Hydra does not issue the final delegated token. The broker has a separate
issuer and signing key so resource APIs can distinguish ordinary Hydra access
tokens from user-plus-service delegated tokens.

### Initial setup

Generate the dedicated signing key outside the repository:

```bash
openssl genpkey -algorithm EC \
  -pkeyopt ec_paramgen_curve:P-256 \
  -out delegation-private.pem
openssl pkey -in delegation-private.pem -pubout -out delegation-public.pem
openssl base64 -A -in delegation-private.pem
```

Paste only the final one-line value into
`DELEGATION_SIGNING_PRIVATE_KEY_B64` in the protected environment source.
Protect the PEM outside the repository and never copy the private key to a
resource or actor application. This release publishes one key: for rotation,
disable issuance, wait at least the maximum configured access-token TTL,
replace both the key and key ID, deploy, and then re-enable issuance.

In the admin console:

1. Create a confidential service OAuth client for each resource authorizer.
   It must use `client_credentials`, allow audience
   `urn:idnest:delegation`, and allow scope `delegation.grant`.
2. Create a separate confidential service client for each actor. It must use
   `client_credentials`, allow the same audience, and allow scope
   `delegation.exchange`.
3. Open **Delegated Access**, create a resource key and URI audience, choose
   the authorizer client, configure the maximum token TTL and scopes, then add
   actor policies whose scopes are subsets of the resource scopes.
4. Review configuration while `DELEGATION_ENABLED=false`. Set it to `true`,
   update the protected GitHub environments, and deploy auth after the policies
   are ready. Disabling it again returns `404` from every broker endpoint while
   leaving administration data intact.

The additive authorization migration creates `delegation_resources`, version
history, actor policies, one-time grants, and audit events. Auth and admin
deployment run migration versions 8 and 9 automatically before starting the new
image. There is no product-specific seed data.

### API contract

Obtain a resource-authorizer service token from Hydra, then issue a grant. The
placeholders below represent secrets and tokens; do not put real values in
shell history or logs:

```bash
curl --request POST https://auth-dev.idnest.cloud/auth/v1/delegation/grants \
  --header 'Authorization: Bearer RESOURCE_SERVICE_TOKEN' \
  --header 'Content-Type: application/json' \
  --data '{
    "resource": "resource-api",
    "subject": "OPAQUE_USER_SUBJECT",
    "actorClientId": "automation-client",
    "scope": ["records:read"],
    "authorizationContext": "OPAQUE_INSTALLATION_REFERENCE",
    "correlationId": "REQUEST_CORRELATION_ID"
  }'
```

The response is valid for at most five minutes and normally 60 seconds:

```json
{
  "grantId": "GRANT_UUID",
  "exchangeToken": "ONE_TIME_RANDOM_VALUE",
  "expiresIn": 60
}
```

The actor exchanges it with its own Hydra service access token:

```bash
curl --request POST https://auth-dev.idnest.cloud/auth/v1/delegation/token \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:token-exchange' \
  --data-urlencode 'subject_token=ONE_TIME_RANDOM_VALUE' \
  --data-urlencode 'subject_token_type=urn:idnest:params:oauth:token-type:delegation-grant' \
  --data-urlencode 'actor_token=ACTOR_SERVICE_TOKEN' \
  --data-urlencode 'actor_token_type=urn:ietf:params:oauth:token-type:access_token' \
  --data-urlencode 'resource=https://api.example.com' \
  --data-urlencode 'scope=records:read'
```

The optional exchange `scope` may only reduce the grant. The delegated access
token uses `typ=at+jwt`, `alg=ES256`, and contains:

- `iss`: the configured delegation issuer, not the Hydra issuer.
- `sub`: the opaque user or service subject supplied by the resource
  authorizer.
- `aud`: exactly one configured resource audience.
- `client_id` and `act.sub`: the actor OAuth client ID.
- `scope`: the canonical, space-separated delegated scopes.
- `authorization_details`: type `urn:idnest:delegation`, the grant ID, and the
  optional opaque context reference.
- `iat`, `nbf`, `exp`, and unique `jti` claims.

Resource APIs must pin the delegation issuer and accepted algorithms, fetch
keys from the broker JWKS endpoint, validate exact audience and expiry, require
both actor claims, check scopes, and resolve the opaque context against their
own current installation and permission data. Do not treat decoding a JWT as
validation, accept the Hydra issuer in its place, or trust context as embedded
business authorization.

Discovery and public keys are exposed only while the feature is enabled:

```text
https://auth-dev.idnest.cloud/.well-known/idnest-delegation-configuration
https://auth-dev.idnest.cloud/auth/v1/delegation/jwks
```

The admin console shows resources, actor policies, pending/exchanged/expired
grants, and append-only audit activity. Administrators and resource
authorizers can revoke only pending one-time grants. Already issued access
tokens remain valid until their short expiry, so keep TTLs minimal and perform
live business checks for actions requiring immediate revocation.

## Authentication flow

1. A product starts an authorization request with Hydra.
2. Hydra sends the login challenge to the trusted auth backend.
3. The backend resolves the client's active brand and authentication policy.
4. Kratos performs identity login and session management.
5. The backend validates the Kratos session, assurance level, verified email,
   and client-access rules before accepting the Hydra challenge.
6. Hydra processes consent and returns an authorization code to the product.
7. The product exchanges the code using its original PKCE verifier.

Resource servers must validate token issuer, signature, expiry, and audience.
Browser state is not an authorization boundary.

Hydra stores `allowed_cors_origins` with the OAuth client and applies changes
without an identity-service restart. Client-identifiable token requests use
that registration, while Hydra's global list remains an infrastructure-only
non-empty baseline. True browser preflights carry no client identity, so this
deployment does not support direct browser `/userinfo` calls. SPAs use ID-token
claims or a same-origin backend instead. Exact HTTP loopback origins are accepted
for local browser clients in every runtime; non-loopback browser origins require
HTTPS. Server web, native, and service clients default to no recorded browser
origins.

Existing installations must replace the former shared
`CORS_ALLOWED_ORIGINS` value before restarting identity services:

```dotenv
HYDRA_CORS_ALLOWED_ORIGINS=https://hydra.example.com
KRATOS_CORS_ALLOWED_ORIGINS=https://auth.example.com
KRATOS_TOTP_ISSUER='Idnest Production'
```

Replace the old auth-application copy with
`AUTH_RETURN_TO_ALLOWED_ORIGINS` during the same release. Identity startup now
fails when either new identity setting is absent, preventing Hydra's enabled
CORS middleware from running with an empty global origin list.

For local development, make the same rename in `monorepo/.env`; preserve only
the origins that are still needed as transitional settings/logout return
destinations. `ADMIN_CORS_ALLOWED_ORIGINS` remains a separate admin-backend
setting. Verify the migrated files and renderers before restarting services:

```bash
pnpm test:cors:config
```

Inventory existing SPA clients with a non-mutating dry run, review the exact
derived origins, then apply the backfill if they are correct:

```bash
pnpm clients:cors:backfill
pnpm clients:cors:backfill -- --apply
```

Install the local and Cloudflare metadata-only rules before restarting Hydra
with the exact non-wildcard global value. After deployment, verify metadata and
the negative protected-route boundary:

```bash
pnpm test:cors:live -- https://hydra-dev.idnest.cloud
```

Hydra v26.2.0 cannot resolve a client-only origin from a true browser preflight
because the `OPTIONS` request carries no client identity. Public SPA token
exchange should remain a CORS-safelisted `application/x-www-form-urlencoded`
request without custom headers. Use ID-token claims or a same-origin BFF instead
of calling UserInfo directly from browser code.

The helper skips clients that already have browser origins and never invents
application return URIs; configure those exact destinations through the admin
UI.
