# Local Development

This guide covers workstation setup, local environment files, browser routing,
and the local service bootstrap.

## Workstation setup

### Prerequisites

- Node.js `22.22.0` (see `.nvmrc`)
- pnpm `9.15.0` through Corepack
- PostgreSQL
- Docker with Docker Compose
- A locally trusted HTTPS gateway for end-to-end browser flows

On macOS, the non-Node dependencies can be installed with Homebrew:

```bash
brew install postgresql@16
brew services start postgresql@16
```

On Ubuntu or Debian, install PostgreSQL using the distribution packages and
Docker using its official packages. Certificate and gateway tooling is left to
each developer's preferred local environment.

### 1. Install dependencies

From the repository root:

```bash
nvm use
corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm workspace:install
```

### 2. Create the environment files

```bash
cp .env.example .env
cp monorepo/.env.example monorepo/.env
```

Replace every placeholder. Generate independent secrets instead of reusing one
value:

```bash
openssl rand -hex 32
openssl rand -hex 16 # Exactly 32 characters for KRATOS_CIPHER_SECRET
```

Set `ADMIN_BOOTSTRAP_EMAILS` to the verified email allowed to become the first
system administrator. Configure Google OIDC with this local redirect URI:

```text
https://kratos-local.idnest.cloud/self-service/methods/oidc/callback/google
```

Apple login is optional. Leave all `APPLE_*` values empty to disable it. When
enabled, its local redirect URI is:

```text
https://kratos-local.idnest.cloud/self-service/methods/oidc/callback/apple
```

### 3. Configure local browser routing

Add these entries to `/etc/hosts`:

```text
127.0.0.1 auth-local.idnest.cloud
127.0.0.1 admin-local.idnest.cloud
127.0.0.1 hydra-local.idnest.cloud
127.0.0.1 kratos-local.idnest.cloud
```

The tracked nginx reference at
`scripts/deploy/nginx/hydra-local.idnest.cloud.conf.example` contains Hydra's
local TLS proxy and discovery-only CORS rule. Adapt the other HTTPS virtual
hosts to the gateway of your choice with a locally trusted certificate and
these routes:

| Browser hostname and path | Direct upstream |
| --- | --- |
| `auth-local.idnest.cloud/auth/v1/*` | `http://127.0.0.1:4000` |
| `auth-local.idnest.cloud/auth/*` | `http://127.0.0.1:4502` |
| All other `auth-local.idnest.cloud` paths | `http://127.0.0.1:4000` |
| `admin-local.idnest.cloud/api/*` and `/config/config.json` | `http://127.0.0.1:4100` |
| All other `admin-local.idnest.cloud` paths | `http://127.0.0.1:4501` |
| All `hydra-local.idnest.cloud` paths | `http://127.0.0.1:4444` |
| All `kratos-local.idnest.cloud` paths | `http://127.0.0.1:4433` |

Preserve the original `Host` header, report the external scheme as HTTPS, and
enable WebSocket forwarding for the two frontend development servers.

For browser OIDC discovery, configure the local gateway to add wildcard CORS
only to `GET`, `HEAD`, and `OPTIONS` responses for these paths:

```text
/.well-known/openid-configuration
/.well-known/oauth-authorization-server
/.well-known/jwks.json
```

Set `Access-Control-Allow-Origin: *` and
`Access-Control-Allow-Methods: GET, HEAD, OPTIONS`, and remove
`Access-Control-Allow-Credentials`. Do not apply this rule to token, userinfo,
revocation, or logout routes. Browser applications must use ID-token claims or
a same-origin backend instead of adding product origins to Hydra's global list
for Authorization-bearing `/userinfo` requests.

The tracked nginx rule uses a method map and an exact anchored metadata matcher:

```nginx
map $request_method $idnest_public_metadata_cors_origin {
  default "";
  GET     "*";
  HEAD    "*";
  OPTIONS "*";
}

location ~ ^/\.well-known/(openid-configuration|oauth-authorization-server|jwks\.json)$ {
  proxy_pass http://localhost:4444;
  proxy_hide_header Access-Control-Allow-Origin;
  proxy_hide_header Access-Control-Allow-Methods;
  proxy_hide_header Access-Control-Allow-Credentials;
  add_header Access-Control-Allow-Origin $idnest_public_metadata_cors_origin always;
}
```

Install the full tracked virtual host, validate with `sudo nginx -t`, and reload
with `sudo nginx -s reload`. Keep the existing locally trusted certificate if
its paths differ. Run the live CORS test after reloading the gateway.

### 4. Bootstrap the local services

```bash
pnpm bootstrap:local
```

The bootstrap command:

1. Loads both environment files.
2. Creates the Hydra, Kratos, and authorization databases and schemas.
3. Runs all database migrations.
4. Starts Hydra and Kratos with Docker Compose.
5. Provisions the confidential admin-console OAuth client.

The database roles, names, passwords, and schemas are derived from `HYDRA_DSN`,
`KRATOS_DSN`, and `AUTHZ_DATABASE_URL`. Use URL-safe passwords or percent-encode
reserved URL characters.

### 5. Start the applications

Run each service in a separate terminal from the repository root:

```bash
pnpm auth-backend:serve
pnpm auth-frontend:serve
pnpm admin-backend:serve
pnpm admin-frontend:serve
```

Open `https://admin-local.idnest.cloud` and sign in with a verified email from
`ADMIN_BOOTSTRAP_EMAILS`. The allowlist can grant the first `system-admin` role
only while no active system administrator exists.

## Configuration

The two environment files have different owners:

| File | Used by | Contains |
| --- | --- | --- |
| `.env` | Docker Compose, Hydra, and Kratos | Hydra/Kratos URLs, DSNs, secrets, cookie settings, and social OIDC credentials |
| `monorepo/.env` | Express applications and workspace scripts | Internal Hydra/Kratos URLs, authorization database, BFF secrets, browser origins, and admin bootstrap settings |

Keep these values aligned:

- `AUTH_URL` and `AUTH_BASE_URL` must use the same browser-facing auth origin.
- `KRATOS_PUBLIC_URL` must be browser-reachable.
- `KRATOS_INTERNAL_URL` should use the direct local public API for backend
  traffic.
- `ADMIN_OIDC_CLIENT_SECRET` must match the client provisioned by the bootstrap
  command.
- `KRATOS_COOKIES_DOMAIN` controls the shared identity-session cookie scope.

### CORS and browser-origin settings

The origin settings are intentionally separate; a global wildcard is not a
substitute for exact client registration:

| Setting | Owner | Purpose |
| --- | --- | --- |
| `.env` → `HYDRA_CORS_ALLOWED_ORIGINS` | Hydra public server | Non-empty infrastructure-only baseline containing Hydra's own public origin. Never add product origins or use `*`; an empty list is also permissive in Hydra v26.2.0. |
| OAuth client → `allowed_cors_origins` | Hydra client registration | Exact browser origins allowed on client-identifiable requests such as a form-encoded public-client token exchange. SPA clients require at least one. |
| `.env` → `KRATOS_CORS_ALLOWED_ORIGINS` | Kratos public server | Browser origin of the trusted auth UI that calls Kratos self-service APIs. |
| `monorepo/.env` → `ADMIN_CORS_ALLOWED_ORIGINS` | Admin backend | Browser origins allowed to call the admin BFF/API. Keep this admin-only. |
| `monorepo/.env` → `AUTH_RETURN_TO_ALLOWED_ORIGINS` | Auth backend | Transitional safe destinations for settings/logout navigation. This is a redirect allowlist, not CORS; new clients should use exact `metadata.allowed_return_uris`. |

Do not copy product-domain wildcards into Hydra, Kratos, or the admin backend.
Add exact SPA browser origins through the admin console, and keep redirect URIs,
post-logout URIs, CORS origins, and application return URIs as independent
client properties. SPAs should disable automatic UserInfo loading and consume
the minimal claims issued in their ID token; use a same-origin backend for
richer or freshly loaded profile data.

Both environment files are ignored by Git. Commit changes to their `.example`
templates when the required configuration contract changes.

## Troubleshooting

Check service health and container state:

```bash
curl http://localhost:4445/health/ready
curl http://localhost:4433/health/ready
curl http://localhost:4000/health
curl http://localhost:4100/health
docker compose -f scripts/docker/docker-compose.yml ps
docker compose -f scripts/docker/docker-compose.yml logs hydra kratos
```

If a Kratos configuration change is not visible, force-recreate the
`idnest-kratos` container and inspect its logs.

For local certificate or gateway failures, verify the four `/etc/hosts`
entries, confirm the wildcard certificate is trusted, and check each route
against the direct upstream table in
[Configure local browser routing](#3-configure-local-browser-routing).

If the first admin login is forbidden, confirm that:

- Kratos reports a verified email.
- The email appears in `ADMIN_BOOTSTRAP_EMAILS`.
- `ADMIN_OIDC_CLIENT_SECRET` matches the provisioned client.
- Authorization migrations completed and both backends can reach
  `AUTHZ_DATABASE_URL`.
