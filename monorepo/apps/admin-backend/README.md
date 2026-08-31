# Admin Backend

The admin backend is the confidential BFF/API for identity and OAuth
administration. It owns admin session protection and backs the admin console's
OAuth client and delegated-access management workflows.

## OAuth clients and access

Manage product OAuth clients and identity access in the admin console.

For browser applications:

- Use Authorization Code with PKCE.
- Configure the client as public with `token_endpoint_auth_method=none`.
- Register exact redirect and post-logout URIs; do not use wildcards.
- Register exact browser origins in **Allowed CORS origins**. The admin UI can
  derive initial origins from redirect URIs, but they remain independently
  editable.
- Do not register IPv6-literal browser origins. Hydra v26.2.0 stores them but
  does not emit client-specific CORS response headers for them, so the admin
  API rejects them instead of accepting a configuration Hydra cannot enforce.
- Register exact **Application return URIs** for standalone settings/logout
  navigation and include the OAuth `client_id` when starting those flows.
- Request only the required scopes and audience.
- Never place a client secret in browser code.

The admin console client is the only bootstrap exception because the console
cannot authenticate until its own confidential client exists. Administrator
roles are represented by `system-admin` access to that client, and the API
prevents removal of the final active system administrator.

Local OIDC discovery is available at:

```text
https://hydra-local.idnest.cloud/.well-known/openid-configuration
```
