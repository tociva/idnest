# Idnest Authentication Platform

Idnest is the authentication and identity platform used by `daybook.cloud`.
It combines Ory Hydra and Ory Kratos with Express backends, Angular frontends,
PostgreSQL, and a shared authorization store in an Nx workspace.

This README is the single project guide. It covers the architecture, local
development, common workflows, and security boundaries.

## Contents

- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Local development](#local-development)
- [Configuration](#configuration)
- [Common commands](#common-commands)
- [OAuth clients and access](#oauth-clients-and-access)
- [Authentication flow](#authentication-flow)
- [Troubleshooting](#troubleshooting)
- [Security notes](#security-notes)

## Architecture

| Component | Local endpoint | Direct port | Responsibility |
| --- | --- | ---: | --- |
| Auth backend | `https://auth-local.idnest.cloud` | `4000` | Trusted Hydra/Kratos orchestration |
| Auth frontend | `https://auth-local.idnest.cloud/auth/` | `4502` | Branded login, consent, and error UI |
| Admin backend | `https://admin-local.idnest.cloud/api` | `4100` | Confidential BFF and administration API |
| Admin frontend | `https://admin-local.idnest.cloud` | `4501` | Identity and OAuth administration console |
| Hydra public API | `https://hydra-local.idnest.cloud` | `4444` | OAuth 2.0 and OpenID Connect endpoints |
| Hydra admin API | Server-side only | `4445` | Privileged OAuth administration |
| Kratos public API | `https://kratos-local.idnest.cloud` | `4433` | Identity self-service and sessions |
| Kratos admin API | Server-side only | `4434` | Privileged identity administration |

Nginx provides locally trusted HTTPS and routes the browser-facing hostnames to
the development servers. The Express backends call the Hydra and Kratos admin
APIs directly; those privileged endpoints must never be browser-accessible.

## Repository layout

```text
.
├── config/                         # Kratos templates, identity schema, and OIDC mappers
├── infrastructure/                 # Infrastructure source files
├── monorepo/
│   ├── apps/auth-backend/          # Express OAuth orchestration service
│   ├── apps/auth-frontend/         # Angular authentication UI
│   ├── apps/admin-backend/         # Express admin BFF/API
│   ├── apps/admin-frontend/        # Angular admin console
│   └── libs/                       # Shared authorization, runtime, and types
├── scripts/
│   ├── authz/                      # Authorization database migrations
│   ├── docker/                     # Local Hydra and Kratos stack
│   └── setup/                      # Local bootstrap and database setup
├── .env.example                    # Hydra and Kratos configuration template
├── monorepo/.env.example           # Application configuration template
└── package.json                    # Root commands
```

## Local development

### Prerequisites

- Node.js `22.22.0` (see `.nvmrc`)
- pnpm `9.15.0` through Corepack
- PostgreSQL
- Docker with Docker Compose
- Nginx
- [`mkcert`](https://github.com/FiloSottile/mkcert)

On macOS, the non-Node dependencies can be installed with Homebrew:

```bash
brew install nginx mkcert nss postgresql@16
brew services start nginx
brew services start postgresql@16
```

On Ubuntu or Debian, install the equivalent packages and start PostgreSQL and
Nginx. Install Docker using its official distribution packages.

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

### 3. Configure local hostnames

Add these entries to `/etc/hosts`:

```text
127.0.0.1 auth-local.idnest.cloud
127.0.0.1 admin-local.idnest.cloud
127.0.0.1 hydra-local.idnest.cloud
127.0.0.1 kratos-local.idnest.cloud
```

### 4. Configure local HTTPS

Install the local certificate authority once:

```bash
mkcert -install
```

For Homebrew Nginx on macOS:

```bash
NGINX_PREFIX="$(brew --prefix)"
SSL_DIR="$NGINX_PREFIX/etc/nginx/ssl"
SERVER_DIR="$NGINX_PREFIX/etc/nginx/servers"

mkdir -p "$SSL_DIR" "$SERVER_DIR"
mkcert \
  -cert-file "$SSL_DIR/local.idnest.cloud.pem" \
  -key-file "$SSL_DIR/local.idnest.cloud-key.pem" \
  "*.idnest.cloud" idnest.cloud
chmod 600 "$SSL_DIR/local.idnest.cloud-key.pem"

for source in scripts/deploy/nginx/local/*.conf; do
  destination="$SERVER_DIR/$(basename "$source")"
  sed "s#/opt/homebrew#$NGINX_PREFIX#g" "$source" > "$destination"
done

nginx -t
brew services restart nginx
```

On Linux, install the certificate and key under `/etc/nginx/ssl`, copy the
files from `scripts/deploy/nginx/local/` into the Nginx configuration directory,
and replace `/opt/homebrew/etc/nginx/ssl` with `/etc/nginx/ssl` in those copies.
Validate with `sudo nginx -t` before restarting Nginx.

### 5. Bootstrap the local services

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

### 6. Start the applications

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
| `.env` | Docker Compose, Hydra, and Kratos | Ory URLs, DSNs, secrets, cookie settings, and social OIDC credentials |
| `monorepo/.env` | Express applications and workspace scripts | Internal Ory URLs, authorization database, BFF secrets, browser origins, and admin bootstrap settings |

Keep these values aligned:

- `AUTH_URL` and `AUTH_BASE_URL` must use the same browser-facing auth origin.
- `KRATOS_PUBLIC_URL` must be browser-reachable.
- `KRATOS_INTERNAL_URL` should use the direct local public API for backend
  traffic.
- `ADMIN_OIDC_CLIENT_SECRET` must match the client provisioned by the bootstrap
  command.
- `KRATOS_COOKIES_DOMAIN` controls the shared identity-session cookie scope.

Both environment files are ignored by Git. Commit changes to their `.example`
templates when the required configuration contract changes.

## Common commands

Run commands from the repository root.

| Command | Purpose |
| --- | --- |
| `pnpm build` | Build every Nx application |
| `pnpm test` | Run all configured tests |
| `pnpm typecheck` | Type-check all projects |
| `pnpm lint` | Lint all projects |
| `pnpm auth-backend:build` | Build only the auth backend |
| `pnpm auth-frontend:build` | Build only the auth frontend |
| `pnpm admin-backend:build` | Build only the admin backend |
| `pnpm admin-frontend:build` | Build only the admin frontend |
| `pnpm authz:migrate` | Run authorization-store migrations |
| `pnpm nx -- graph` | Open the Nx project graph |

Manage the local Ory services directly when needed:

```bash
docker compose -f scripts/docker/docker-compose.yml up -d
docker compose -f scripts/docker/docker-compose.yml ps
docker compose -f scripts/docker/docker-compose.yml logs -f
docker compose -f scripts/docker/docker-compose.yml down
```

After changing `.env` or `config/kratos.tpl.yml`, recreate Kratos so the
generated configuration is refreshed:

```bash
docker compose -f scripts/docker/docker-compose.yml up -d --force-recreate ory-kratos
```

## OAuth clients and access

Manage product OAuth clients and identity access in the admin console.

For browser applications:

- Use Authorization Code with PKCE.
- Configure the client as public with `token_endpoint_auth_method=none`.
- Register exact redirect and post-logout URIs; do not use wildcards.
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

## Troubleshooting

Check service health and container state:

```bash
curl http://localhost:4445/health/ready
curl http://localhost:4433/health/ready
curl http://localhost:4000/health
curl http://localhost:4100/health
docker compose -f scripts/docker/docker-compose.yml ps
docker compose -f scripts/docker/docker-compose.yml logs ory-hydra ory-kratos
```

If a Kratos configuration change is not visible, force-recreate the
`ory-kratos` container and inspect its logs.

For local certificate or proxy failures, verify the four `/etc/hosts` entries,
run `nginx -t` (or `sudo nginx -t`), and use `mkcert -CAROOT` to confirm the
local certificate authority.

If the first admin login is forbidden, confirm that:

- Kratos reports a verified email.
- The email appears in `ADMIN_BOOTSTRAP_EMAILS`.
- `ADMIN_OIDC_CLIENT_SECRET` matches the provisioned client.
- Authorization migrations completed and both backends can reach
  `AUTHZ_DATABASE_URL`.

## Security notes

- Never expose the Hydra or Kratos admin APIs publicly.
- Never commit `.env` files, private keys, tokens, or generated secrets.
- Use separate random values for independent secrets and rotate exposed values.
- The admin browser receives only an opaque, HttpOnly BFF session cookie.
- The backend revalidates identity status, verified email, and active grants for
  privileged operations.
- Social identities without a verified email are rejected before tokens are
  issued.
- UI visibility is not authorization; enforcement belongs in the backend.
