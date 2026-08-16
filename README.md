# Idnest Auth — Ory Hydra + Kratos

This repository contains the Idnest authentication platform used by
`daybook.cloud`. It combines Ory Hydra, Ory Kratos, PostgreSQL, two Express
backends, a dedicated Angular authentication surface, and an Angular
administration console.

This is the application and local-development guide for the repository,
including the Nx workspace under `monorepo/`. VPS operations are documented in
the dedicated direct-TLS runbook linked below.

> Deploying a VPS environment? Start with the
> [direct-TLS VPS runbook](scripts/deploy/vps/README.md).

## 1. Architecture

| Component | Local URL | Direct port | Purpose |
| --- | --- | ---: | --- |
| Auth backend | `https://auth-local.idnest.cloud` | `4000` | Trusted Hydra/Kratos orchestration plus legacy rollback pages |
| Auth frontend | `https://auth-local.idnest.cloud/auth/` | `4502` | Client-branded login, consent, and neutral error pages |
| Hydra public | `https://hydra-local.idnest.cloud` | `4444` | OAuth 2.0 and OpenID Connect endpoints |
| Hydra admin | Server-side only | `4445` | Privileged Hydra API |
| Kratos public | `https://kratos-local.idnest.cloud` | `4433` | Identity self-service and session endpoints |
| Kratos admin | Server-side only | `4434` | Privileged identity API |
| Admin backend | `https://admin-local.idnest.cloud/api` | `4100` | Confidential BFF and administration API |
| Admin frontend | `https://admin-local.idnest.cloud` | `4501` | Angular administration console |

Local development reaches the public services through Nginx and mkcert HTTPS.
On a VPS, auth, admin, Hydra, and Kratos terminate Cloudflare Origin CA TLS
directly on fixed origin ports; Nginx is not installed. The admin and auth
Angular applications share their public origins with their Express backends, so
host-only cookies and browser API requests remain same-origin. Hydra/Kratos
admin endpoints remain private and are used only by the backends.

Repository layout:

```text
.
├── config/                    # Kratos templates, schemas, and OIDC mappers
├── scripts/
│   ├── authz/                 # Authorization database migration scripts
│   ├── deploy/                # local nginx and direct-TLS VPS deployment files
│   ├── docker/                # Hydra/Kratos Compose stack
│   └── setup/                 # Bootstrap, shared env loader, and OS setup scripts
├── monorepo/
│   ├── apps/auth-backend/     # Express trusted auth orchestrator
│   ├── apps/auth-frontend/    # Angular client-branded auth UI
│   ├── apps/admin-backend/    # Express admin BFF/API
│   ├── apps/admin-frontend/   # Angular admin console
│   └── libs/                  # Shared types and authorization store
├── .env.example               # Infrastructure env template
└── monorepo/.env.example      # Application env template
```

## 2. Fresh installation

Complete the shared steps and then the operating-system block for your machine.

### 2.1 Shared prerequisites

- Git
- Node.js `22.22.0` (the version in the root `.nvmrc`)
- pnpm `9.15.0` through Corepack
- PostgreSQL
- Docker with the Compose plugin
- nginx
- [`mkcert`](https://github.com/FiloSottile/mkcert) for locally trusted HTTPS

Use the official installation documentation for
[Node.js 22](https://nodejs.org/en/download/archive/v22) and
[Docker](https://docs.docker.com/engine/install/) when they are not already
installed.

Verify the toolchain:

```bash
node --version
pnpm --version
psql --version
docker --version
docker compose version
nginx -v
mkcert --version
```

### 2.2 macOS prerequisites

Install Homebrew packages:

```bash
brew install git nginx mkcert nss postgresql@16
brew services start postgresql@16
brew services start nginx

export PATH="$(brew --prefix postgresql@16)/bin:$PATH"
```

Install and start Docker Desktop if it is not already available. Then verify
that `docker info` succeeds.

Install Node with your preferred version manager. With `nvm`:

```bash
nvm install
nvm use
corepack enable
corepack prepare pnpm@9.15.0 --activate
```

### 2.3 Linux prerequisites

The commands below target Ubuntu/Debian. Use the equivalent packages on other
distributions.

```bash
sudo apt update
sudo apt install -y git curl nginx postgresql postgresql-client libnss3-tools
sudo systemctl enable --now postgresql nginx
```

Install Docker Engine and its Compose plugin using the
[official distribution instructions](https://docs.docker.com/engine/install/).
If Docker is configured for non-root use, verify that `docker info` succeeds as
your normal user.

Install `mkcert`. For Linux amd64, the upstream project provides this installer:

```bash
curl -JLO "https://dl.filippo.io/mkcert/latest?for=linux/amd64"
chmod +x mkcert-v*-linux-amd64
sudo install -m 0755 mkcert-v*-linux-amd64 /usr/local/bin/mkcert
```

Use the matching upstream binary for arm64 or another architecture.

Install Node `22.22.0` with your preferred version manager, then enable the
pinned pnpm version:

```bash
nvm install
nvm use
corepack enable
corepack prepare pnpm@9.15.0 --activate
```

### 2.4 Install repository dependencies

From the repository root:

```bash
pnpm workspace:install
pnpm build
```

### 2.5 Configure local DNS

Add the Idnest development hosts to `/etc/hosts`:

```text
127.0.0.1 auth-local.idnest.cloud
127.0.0.1 hydra-local.idnest.cloud
127.0.0.1 kratos-local.idnest.cloud
127.0.0.1 admin-local.idnest.cloud
```

If the Daybook product frontend/API also run on this machine, add their local
hosts from the Daybook repository as well.

### 2.6 Configure local HTTPS and nginx

Install the local certificate authority once:

```bash
mkcert -install
```

#### macOS nginx block

Homebrew may be installed under `/opt/homebrew` or `/usr/local`; the commands
below adapt the checked-in nginx files to the active prefix.

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

#### Linux nginx block

The checked-in local nginx files use the Homebrew certificate path. Generate
Linux copies with `/etc/nginx/ssl` instead:

```bash
cert_dir="$(mktemp -d)"
mkcert \
  -cert-file "$cert_dir/local.idnest.cloud.pem" \
  -key-file "$cert_dir/local.idnest.cloud-key.pem" \
  "*.idnest.cloud" idnest.cloud

sudo install -d -m 0755 /etc/nginx/ssl
sudo install -m 0644 "$cert_dir/local.idnest.cloud.pem" /etc/nginx/ssl/
sudo install -m 0600 "$cert_dir/local.idnest.cloud-key.pem" /etc/nginx/ssl/

for source in scripts/deploy/nginx/local/*.conf; do
  destination="/etc/nginx/conf.d/$(basename "$source")"
  sed 's#/opt/homebrew/etc/nginx/ssl#/etc/nginx/ssl#g' "$source" \
    | sudo tee "$destination" >/dev/null
done

sudo nginx -t
sudo systemctl restart nginx
```

### 2.7 Configure Google and optional Apple login

Create a Google OAuth web application and register this redirect URI:

```text
https://kratos-local.idnest.cloud/self-service/methods/oidc/callback/google
```

Put the Google client ID and secret in the root `.env`. For production, add the
equivalent `https://kratos.idnest.cloud/.../google` redirect.

Apple login is optional. It is rendered only when all four `APPLE_*` values are
present. Its local callback is:

```text
https://kratos-local.idnest.cloud/self-service/methods/oidc/callback/apple
```

### 2.8 Create and fill both env files

```bash
cp .env.example .env
cp monorepo/.env.example monorepo/.env
```

The files have separate responsibilities:

- `./.env` contains Hydra/Kratos infrastructure configuration and social OIDC
  credentials. Docker Compose and Kratos config rendering consume it.
- `monorepo/.env` contains backend URLs, Authz configuration, admin BFF
  secrets, the first-admin email allowlist, and browser runtime configuration.

Generate independent development secrets rather than reusing one value: 

```bash
openssl rand -hex 32   # long secret: Hydra, CSRF, consent, admin client
openssl rand -hex 16   # exactly 32 characters: KRATOS_CIPHER_SECRET
```

Important database rules:

- `HYDRA_DSN` is the Hydra database source of truth.
- `KRATOS_DSN` is the Kratos database source of truth.
- `AUTHZ_DATABASE_URL` in `monorepo/.env` is the Authz database source of truth.
- The setup scripts derive each database user, password, database name, and
  default schema from these URLs. Do not add separate `*_DB_USER`,
  `*_DB_PASSWORD`, `*_DB_NAME`, or `*_DB_SCHEMA` entries.
- Use URL-safe passwords or percent-encode reserved URL characters.

Set `ADMIN_BOOTSTRAP_EMAILS` to a comma-separated allowlist containing the
verified Google/Apple email permitted to become the first administrator:

```dotenv
ADMIN_BOOTSTRAP_EMAILS=admin@example.com
```

When there are zero active system administrators, the first verified login
matching this list receives the initial `system-admin` grant atomically. Once an
administrator exists, the allowlist cannot grant additional administrators.

`AUTH_URL` in the root file and `AUTH_BASE_URL` in the monorepo file must use
the same origin. `KRATOS_PUBLIC_URL` must be browser-reachable, while
`KRATOS_INTERNAL_URL` should use local HTTP for backend-to-Kratos calls.

Key cross-file wiring:

| Variable | File | Purpose |
| --- | --- | --- |
| `AUTH_URL` | `./.env` | Sets Hydra's login, consent, logout, and error UI origin and Kratos's UI origin |
| `AUTH_BASE_URL` | `monorepo/.env` | Builds the auth backend return URL after Kratos login |
| `KRATOS_SERVE_PUBLIC_BASE_URL` | `./.env` | Public origin Kratos writes into self-service flow actions |
| `KRATOS_PUBLIC_URL` | `monorepo/.env` | Browser-reachable Kratos origin used for redirects |
| `KRATOS_INTERNAL_URL` | `monorepo/.env` | Direct backend-to-Kratos public API connection |
| `KRATOS_COOKIES_DOMAIN` | `./.env` | Shared identity-session cookie scope, normally `.idnest.cloud` |

### 2.9 Bootstrap databases and Ory

Run from the repository root:

```bash
pnpm bootstrap:local
```

The bootstrap performs these operations:

1. Loads both env files.
2. Derives all PostgreSQL provisioning fields from the three database URLs.
3. Creates the Hydra, Kratos, and Authz roles/databases/schemas.
4. Runs Hydra, Kratos, and Authz migrations.
5. Starts the Hydra and Kratos containers.
6. Provisions only `idnest-admin-client`, the confidential infrastructure
   client required for the admin console to authenticate.

Product OAuth clients are not seeded by scripts. They are created in the admin
UI after the first administrator signs in.

### Product access policy

Taskmesh remains invitation-only until subscription provisioning is available.
Its authentication policy (`Invite Only`) uses
`registrationMode: invitation-only` and `identityGate: invitation`, so Google
sign-in alone does not grant Taskmesh access. An Idnest administrator must
grant each approved identity access to `taskmesh-console` from
**Identities → [identity] → Client access**.

Do not switch Taskmesh to open access until subscription provisioning can
automatically authorize eligible users.

If Kratos identities were reset while Authz data was retained, inspect the
seeded administrator grants whose identities no longer exist:

```bash
node ./scripts/setup/provision-admin-client.js --repair-stale-admin-grants --dry-run
```

Then repair the reported stale grants before signing in:

```bash
node ./scripts/setup/provision-admin-client.js --repair-stale-admin-grants
```

The next verified login matching `ADMIN_BOOTSTRAP_EMAILS` then receives the
first `system-admin` grant. The repair command does not recreate the OAuth client.

The OS-specific setup scripts can also be run directly:

```bash
# macOS
./scripts/setup/setup-ory-db-macos.sh

# Linux
./scripts/setup/setup-ory-db-linux.sh
```

Those scripts perform database provisioning and Ory migrations, but the full
bootstrap is recommended for a new installation because it also migrates Authz,
starts the containers, and provisions the admin infrastructure client.

### 2.10 Start the applications

Use four terminals from the repository root:

```bash
# Terminal 1
pnpm auth-backend:serve

# Terminal 2
pnpm auth-frontend:serve

# Terminal 3
pnpm admin-backend:serve

# Terminal 4
pnpm admin-frontend:serve
```

The default direct ports are auth backend `4000`, auth frontend `4502`, admin
backend `4100`, and admin frontend `4501`.

Verify the services:

```bash
curl http://localhost:4445/health/ready
curl http://localhost:4433/health/ready
curl http://localhost:4000/health
curl http://localhost:4100/health
curl -I https://admin-local.idnest.cloud
```

### 2.11 Sign in as the first administrator

1. Open `https://admin-local.idnest.cloud`.
2. Sign in with a verified email listed in `ADMIN_BOOTSTRAP_EMAILS`.
3. The admin backend grants the first `system-admin` role only if no active
   administrator exists.
4. Confirm that the Identities and OAuth Clients pages load.
5. Optionally clear `ADMIN_BOOTSTRAP_EMAILS` and restart `admin-backend` after
   the first administrator is established.

All later administrator roles, identity access grants, sessions, and product
OAuth clients are managed from the admin UI.

## 3. Daily development commands

Run all workspace commands from the repository root:

```bash
pnpm build
pnpm auth-backend:build
pnpm auth-frontend:build
pnpm admin-backend:build
pnpm admin-frontend:build
pnpm test
pnpm typecheck
pnpm lint

pnpm auth-backend:serve
pnpm admin-backend:serve
pnpm admin-frontend:serve

pnpm authz:migrate
```

Manage the Ory containers from the repository root:

```bash
docker compose -f scripts/docker/docker-compose.yml up -d
docker compose -f scripts/docker/docker-compose.yml logs -f
docker compose -f scripts/docker/docker-compose.yml down
```

After editing the root `.env` or `config/kratos.tpl.yml`, recreate Kratos so its
rendered configuration is refreshed:

```bash
docker compose -f scripts/docker/docker-compose.yml up -d --force-recreate ory-kratos
```

## 4. Manage OAuth clients and identity access

Use the admin console instead of static client files or seeding scripts.

### Create a product client

1. Open **OAuth Clients** in the admin console.
2. Create a unique `client_id` for the product.
3. For a browser SPA, select a public client using
   `token_endpoint_auth_method=none` and PKCE.
4. Set exact `redirect_uris` and `post_logout_redirect_uris`; do not use
   wildcard callback URLs.
5. Assign an app-specific audience.
6. Include only the required scopes, normally `openid profile email` and
   optionally `offline_access`.

For example, a Daybook browser client would use these values in the admin UI:

```json
{
  "client_id": "daybook-user-client",
  "client_name": "Daybook User Client",
  "public": true,
  "scope": "openid profile email offline_access",
  "metadata": {
    "trust_tier": "first_party",
    "consent_version": 1,
    "remember_offline_access": true
  },
  "redirect_uris": ["https://app.daybook.cloud/auth/callback"],
  "post_logout_redirect_uris": ["https://app.daybook.cloud/auth/logout"],
  "audience": ["daybook.cloud-users"]
}
```

Use the equivalent `*-local` URLs while developing locally. Only first-party
clients may enable `remember_offline_access`; leave it disabled unless the
product requires refresh tokens without a repeated consent prompt.

### Grant identity access

Use either an identity detail page or a client detail page to grant/revoke
central access. Administrator roles are represented by a `system-admin` grant
for `idnest-admin-client`. The UI prevents revoking the final active system
administrator.

The admin console itself is the only client provisioned outside the UI. This is
an intentional bootstrap exception: the console cannot authenticate until its
own confidential client exists.

### Integrate a browser client

Hydra publishes OIDC discovery at:

```text
https://hydra.idnest.cloud/.well-known/openid-configuration
```

Use `https://hydra-local.idnest.cloud/.well-known/openid-configuration` locally.
A product SPA can configure
[`oidc-client-ts`](https://github.com/authts/oidc-client-ts) as follows:

```ts
import { UserManager, WebStorageStateStore } from "oidc-client-ts";

export const userManager = new UserManager({
  authority: "https://hydra.idnest.cloud/",
  client_id: "daybook-user-client",
  redirect_uri: "https://app.daybook.cloud/auth/callback",
  post_logout_redirect_uri: "https://app.daybook.cloud/auth/logout",
  response_type: "code",
  scope: "openid profile email offline_access",
  extraQueryParams: { audience: "daybook.cloud-users" },
  userStore: new WebStorageStateStore({ store: window.localStorage }),
});

// Start login:
userManager.signinRedirect();

// Complete /auth/callback:
await userManager.signinRedirectCallback();

// Start logout:
userManager.signoutRedirect();
```

The library generates PKCE values for the public client; never ship a client
secret in a browser application. The equivalent authorization request has this
shape:

```text
https://hydra.idnest.cloud/oauth2/auth
  ?client_id=daybook-user-client
  &response_type=code
  &scope=openid%20profile%20email%20offline_access
  &redirect_uri=https%3A%2F%2Fapp.daybook.cloud%2Fauth%2Fcallback
  &audience=daybook.cloud-users
  &state=<random>
  &code_challenge=<base64url-sha256-verifier>
  &code_challenge_method=S256
```

After the callback, exchange the returned code and original PKCE verifier at
`https://hydra.idnest.cloud/oauth2/token`. The browser uses Hydra's public
authorize/token endpoints and the auth UI; Hydra and Kratos admin URLs remain
server-side.

## 5. Authentication flow

```text
Product app
  → Hydra authorization endpoint
  → auth-backend trusted login orchestrator
  → client-specific Angular login page
  → Kratos social login
  → single-use auth-backend completion
  → branded consent (when required)
  → product callback with authorization code
```

Public browser clients must use Authorization Code + PKCE. Resource servers
must validate issuer, signature, expiration, and audience rather than trusting
browser state.

The trusted flow is:

1. The product sends an authorization request to Hydra with its client,
   redirect URI, scopes, audience, state, and PKCE challenge.
2. Hydra sends a `login_challenge` to `/oauth2/login`. The backend retrieves the
   request from Hydra's admin API and uses only its trusted `client_id`.
3. The backend resolves the active brand, authentication policy, and consent
   mode, then freezes their versions in an encrypted, expiring, single-use
   transaction.
4. Kratos owns credentials and sessions. The Angular UI receives only a
   sanitized flow and the frozen public brand/policy context.
5. After authentication, Kratos returns an opaque transaction token to
   `/oauth2/login/complete`. The backend re-fetches Hydra state, validates the
   Kratos session, AAL, method, verified email, freshness, and identity gate /
   client access, then accepts or rejects the Hydra challenge exactly once.
6. Hydra sends a `consent_challenge` to `/oauth2/consent`. The backend reuses
   the frozen authentication snapshot, validates the subject and session, and
   either auto-accepts according to policy or shows branded consent.
7. Hydra returns an authorization code to the product callback, where the
   product exchanges it with its PKCE verifier.
8. Logout terminates the Kratos session, relays the cookie-clearing response,
   and then accepts Hydra's logout challenge.

Authentication brands, authentication policies, and OAuth client mappings are
managed from the admin console's **Authentication** page. Policy names describe
who may authenticate and why (for example `Approved Users`, `Public Access`, or
`Staff MFA`); structured fields describe methods, external identity providers,
identity gate, assurance, registration, and session requirements. Providers such
as Google belong in configuration, not in the policy name.
Definitions have immutable version history and optimistic concurrency; new
transactions use the current active versions while in-flight transactions keep
their frozen snapshots.

Auth client configuration is modeled as reusable policies assigned to many
Hydra clients:

```text
Auth Client
   │
   ├── Authentication Policy
   │      ├── Sign-in Methods
   │      ├── Identity Gate
   │      ├── Assurance / MFA
   │      ├── Registration Policy
   │      └── Session Policy
   │
   ├── Consent Policy (future)
   │
   ├── Token Policy (future)
   │
   └── Branding
```

Client mappings currently resolve to a policy's latest active version. Per-client
version pinning (for example `daybook-admin → Staff MFA:v2`) is a planned
extension so editing a shared policy does not silently change behavior for every
assigned application.

## 6. Legacy development deployment runbook (superseded)

> **Current deployment:** the VPS now uses direct application/Ory TLS with
> fixed Cloudflare origin ports and no Nginx reverse proxy. The authoritative
> setup and release contract is
> [`scripts/deploy/vps/README.md`](scripts/deploy/vps/README.md). The older
> Nginx/blue-green notes retained below describe the superseded rollout and
> must not be used for a new host. The direct-TLS runbook includes the current
> Terraform, generated GitHub environment files, and bulk-upload commands.

Development uses exactly two workflows:

| Workflow | Image contents | Public routes |
| --- | --- | --- |
| `.github/workflows/deploy-auth-development.yml` | Auth backend, Angular auth frontend, Authz migration | `/auth/`, `/auth/v1/*`, `/oauth2/*`, `/login`, `/logout` |
| `.github/workflows/deploy-admin-development.yml` | Admin backend, Angular admin frontend, Authz migration | `/`, `/api/admin/*`, `/config/config.json` |

Nginx is the public TLS edge. It proxies each complete application to the active
blue/green container; it does not publish Angular files from `/var/www`.
Hydra and Kratos remain separate containers and are managed by the auth
workflow. Complete the following one-time setup before the first deployment.

The privilege boundary is intentional:

| Where | Privilege | Responsibility |
| --- | --- | --- |
| VPS administrator, once | `sudo`/root | Install packages, Docker/Nginx/TLS, create the SSH user, bootstrap the root-owned systemd queue processor, prepare PostgreSQL, and edit `/etc/ory-auth/*.conf` |
| Local administrator, once | No local `sudo` | Prepare encrypted secret sources, Terraform inputs, the GitHub SSH key, and bulk GitHub environment values/secrets |
| GitHub Actions, every release | No VPS `sudo` | Build and push the image, upload release inputs and checked-in host assets, submit an unprivileged queue request, and wait for the result |
| VPS queue processor, every release | Root via systemd | Validate the request, activate the transferred host assets, run migrations/deployment, reload Nginx, and publish the result |

The GitHub SSH user is not in the Docker group and receives no deployment
`sudoers` rule. GitHub Actions never invokes `sudo`.

### 1. On the VPS: prepare the host

The examples below assume Ubuntu/Debian, a deployment user named
`github-deploy`, and the external Docker network `ory-runtime-development`.

#### 1.1 Verify prerequisites

Using the VPS administrator account, install Docker Engine with the Compose
plugin, Nginx, `curl`, `util-linux` (for `flock`), `tar`, `sha256sum`, and
OpenSSL.
PostgreSQL may run on this
VPS or on a private database host. Git is not required on the VPS.

```bash
sudo apt update
sudo apt install -y ca-certificates curl nginx openssl tar util-linux
sudo systemctl enable --now docker nginx

docker --version
docker compose version
nginx -v
command -v curl flock openssl tar sha256sum systemctl
```

Only SSH, HTTP, and HTTPS should be publicly reachable. Ports `4001`, `4002`,
`4101`, `4102`, `4433`, `4434`, `4444`, and `4445` must remain loopback-only.

Create the unprivileged deployment user. Do not add it to the Docker group:

```bash
sudo adduser --disabled-password --gecos '' github-deploy
id github-deploy
```

#### 1.2 Prepare DNS and TLS

Create DNS records for all four development hosts and point them to the VPS:

- `auth-dev.idnest.cloud`
- `admin-dev.idnest.cloud`
- `hydra-dev.idnest.cloud`
- `kratos-dev.idnest.cloud`

The checked-in development Nginx files expect the certificate and key below.
Install the existing wildcard/Cloudflare origin certificate there, or update all
four virtual hosts to the certificate paths used by this VPS.

```bash
sudo test -r /etc/nginx/ssl/idnest-cloud/idnest-cloudflare-origin.pem
sudo test -r /etc/nginx/ssl/idnest-cloud/idnest-cloudflare-origin-key.pem
```

#### 1.3 Install the root-owned deployment assets

Create the provisioning bundle from the trusted local checkout and transfer it
using the normal VPS administrator account:

```bash
# Local machine, from the repository root
export ORY_DEPLOY_INPUTS_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/ory-auth-apps/development"
install -d -m 700 "${ORY_DEPLOY_INPUTS_DIR:?}"
test ! -e "${ORY_DEPLOY_INPUTS_DIR:?}/host-release-signing-private.pem"
test ! -e "${ORY_DEPLOY_INPUTS_DIR:?}/host-release-signing-public.pem"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 \
  -out "${ORY_DEPLOY_INPUTS_DIR:?}/host-release-signing-private.pem"
openssl pkey \
  -in "${ORY_DEPLOY_INPUTS_DIR:?}/host-release-signing-private.pem" \
  -pubout \
  -out "${ORY_DEPLOY_INPUTS_DIR:?}/host-release-signing-public.pem"
chmod 600 "${ORY_DEPLOY_INPUTS_DIR:?}/host-release-signing-private.pem"

ssh-keygen -t ed25519 \
  -N '' \
  -C github-actions-ory-development \
  -f "${ORY_DEPLOY_INPUTS_DIR:?}/github-deploy-ed25519"
ssh-keyscan -p 22 your-vps.example.com \
  > "${ORY_DEPLOY_INPUTS_DIR:?}/vps-known-hosts"
chmod 600 "${ORY_DEPLOY_INPUTS_DIR:?}/github-deploy-ed25519" \
  "${ORY_DEPLOY_INPUTS_DIR:?}/vps-known-hosts"

install -d -m 700 tmp/vps-provision
tar -czf tmp/vps-provision/ory-auth-vps-provision.tar.gz \
  scripts/deploy/vps \
  scripts/deploy/nginx/dev \
  scripts/docker/render-kratos-config.sh \
  scripts/setup/setup-ory-db-linux.sh \
  scripts/setup/load-project-env.sh \
  config/kratos.tpl.yml \
  config/kratos \
  monorepo/.env.example

(
  cd tmp/vps-provision
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 ory-auth-vps-provision.tar.gz
  else
    sha256sum ory-auth-vps-provision.tar.gz
  fi > ory-auth-vps-provision.tar.gz.sha256
)

scp tmp/vps-provision/ory-auth-vps-provision.tar.gz \
  tmp/vps-provision/ory-auth-vps-provision.tar.gz.sha256 \
  "${ORY_DEPLOY_INPUTS_DIR:?}/host-release-signing-public.pem" \
  "${ORY_DEPLOY_INPUTS_DIR:?}/github-deploy-ed25519.pub" \
  your-vps-admin@your-vps.example.com:
```

For later bootstrap updates, reuse both protected key pairs. Do not rerun the
key-generation commands unless you are deliberately rotating the signing or
deployment SSH key.

Verify and extract the bundle on the VPS. The provisioning script installs the
root-owned Compose/deployment assets, all four development Nginx virtual hosts,
the unprivileged submit/wait helpers, and the root systemd queue processor. It
also removes the obsolete `/etc/sudoers.d/ory-auth-deploy` policy if an older
bootstrap created it.

```bash
# VPS
cd "${HOME:?}"
sha256sum --check ory-auth-vps-provision.tar.gz.sha256
ORY_VPS_BOOTSTRAP_DIR="$(mktemp -d "${PWD}/ory-auth-vps-bootstrap.XXXXXX")"
tar -xzf ory-auth-vps-provision.tar.gz \
  --directory "${ORY_VPS_BOOTSTRAP_DIR:?}"
cd "${ORY_VPS_BOOTSTRAP_DIR:?}"

sudo scripts/deploy/vps/provision-host.sh \
  github-deploy \
  ory-runtime-development \
  "${HOME:?}/host-release-signing-public.pem" \
  "${HOME:?}/github-deploy-ed25519.pub"
rm -f "${HOME:?}/host-release-signing-public.pem" \
  "${HOME:?}/github-deploy-ed25519.pub"

sudoedit /etc/ory-auth/auth.conf
sudoedit /etc/ory-auth/admin.conf
sudo nginx -t
sudo systemctl is-active ory-auth-release-queue.path
```

Confirm these values in the two `/etc/ory-auth/*.conf` files:

| File | Required values |
| --- | --- |
| `auth.conf` | Network `ory-runtime-development`, ports `4001/4002`, public health URL `https://auth-dev.idnest.cloud/health` |
| `admin.conf` | Network `ory-runtime-development`, ports `4101/4102`, public health URL `https://admin-dev.idnest.cloud/health` |

This manual bootstrap is one time. Normal changes to Compose files, app deploy
and rollback scripts, the environment validator, development Nginx virtual
hosts, or `render-kratos-config.sh` are bundled and activated automatically by
the next workflow. Kratos templates/schemas travel in the auth release request.

Only changes to the privilege-boundary files themselves require repeating this
manual bootstrap: `provision-host.sh`, `activate-host-release.sh`,
`process-ory-release-queue.sh`, `submit-ory-release.sh`,
`wait-ory-release.sh`, or either `ory-auth-release-queue.*` systemd unit. Review
those changes before rerunning the bootstrap. Protect the `development-auth`
and `development-admin` GitHub environments because an approved workflow
release can update root-executed deployment assets through the validator. The
root-owned public key verifies every bundle, so the SSH deployment key alone
cannot authorize modified host scripts. Rotate the signing key only by manually
rerunning this bootstrap with the new public key and then updating both GitHub
environment secrets.

After the bootstrap, verify the non-sudo interface as the deployment user:

```bash
sudo -u github-deploy test -w /var/lib/ory-auth/queue/incoming
sudo -u github-deploy test ! -w /usr/local/sbin
sudo -u github-deploy /usr/local/bin/submit-ory-release 2>&1 | head -n 1
```

The final command is expected to print its usage error; it confirms the helper
is executable without granting root access.

#### 1.4 Prepare PostgreSQL

Before the first auth deployment, create three login roles and databases that
match the DSNs prepared in step 2:

- Hydra: `HYDRA_DSN`
- Kratos: `KRATOS_DSN`
- Authorization store: `AUTHZ_DATABASE_URL`

If PostgreSQL runs on the VPS, it must accept connections from the Docker bridge
used by `host.docker.internal`; do not expose PostgreSQL publicly. The repository
helper `scripts/setup/setup-ory-db-linux.sh` can create the roles/databases and
run the initial Hydra/Kratos migrations when a temporary root `.env` and
`monorepo/.env` containing those three DSNs are present. Remove those temporary
files after bootstrap. Regular release migrations are run by the workflows.

After preparing the files in step 2, one concrete way to use the helper is:

```bash
# Local machine: copy the two protected inputs to the VPS administrator.
export ORY_DEPLOY_INPUTS_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/ory-auth-apps/development"
scp "${ORY_DEPLOY_INPUTS_DIR:?}/ory.env" \
  your-vps-admin@your-vps.example.com:~/ory-bootstrap.env
scp "${ORY_DEPLOY_INPUTS_DIR:?}/auth-app.env" \
  your-vps-admin@your-vps.example.com:~/ory-bootstrap-app.env

# VPS, from the extracted provisioning directory. Stop if either destination already exists.
test ! -e .env
test ! -e monorepo/.env
sudo install -o root -g root -m 600 ~/ory-bootstrap.env .env
sudo install -o root -g root -m 600 ~/ory-bootstrap-app.env monorepo/.env
sudo scripts/setup/setup-ory-db-linux.sh
sudo rm -f .env monorepo/.env
rm -f ~/ory-bootstrap.env ~/ory-bootstrap-app.env
```

This helper requires a local PostgreSQL server with a `postgres` operating-system
user plus Node.js and Docker on the VPS. For an external or managed PostgreSQL
service, have its DBA create the same roles, databases, ownership, and schemas
instead.

### 2. On the local machine: prepare deployment inputs

Do this from the repository root. Keep every generated file outside Git and
under a directory with restrictive permissions.

```bash
export ORY_DEPLOY_INPUTS_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/ory-auth-apps/development"
install -d -m 700 "${ORY_DEPLOY_INPUTS_DIR:?}"

install -m 600 scripts/deploy/env/auth-app.env.example \
  "${ORY_DEPLOY_INPUTS_DIR:?}/auth-app.env"
install -m 600 scripts/deploy/env/admin-app.env.example \
  "${ORY_DEPLOY_INPUTS_DIR:?}/admin-app.env"
install -m 600 .env.example \
  "${ORY_DEPLOY_INPUTS_DIR:?}/ory.env"
```

Edit all three files and replace every placeholder:

```bash
${EDITOR:-vi} "${ORY_DEPLOY_INPUTS_DIR:?}/auth-app.env"
${EDITOR:-vi} "${ORY_DEPLOY_INPUTS_DIR:?}/admin-app.env"
${EDITOR:-vi} "${ORY_DEPLOY_INPUTS_DIR:?}/ory.env"
```

Use the following rules:

- Replace every `*-local.idnest.cloud` value in `ory.env` with the matching
  `*-dev.idnest.cloud` host.
- Use `http://ory-hydra:4445` and `http://ory-kratos:4434` for container-side
  admin APIs.
- Use `host.docker.internal` in PostgreSQL DSNs when PostgreSQL runs on the VPS.
- Use separate random values for every signing, cookie, cipher, CSRF, consent,
  transaction, and audit secret.
- Make `ADMIN_OIDC_CLIENT_SECRET` identical in the admin environment and the
  Hydra admin-client registration performed in step 6.
- Remove `ADMIN_FRONTEND_API_BASE_URL` and
  `ADMIN_FRONTEND_AUTH_LOGOUT_URL` from the private `admin-app.env`; GitHub
  supplies these two browser-public values as environment variables.
- Leave all Apple settings blank to disable Apple. If enabled, store the private
  key on one physical line with escaped `\n` characters.

The bootstrap in step 1.3 already installed the dedicated deployment public key
and the same step captured the host key. Verify the `ssh-keyscan` fingerprint
through a second trusted channel, then test the non-sudo account from the local
machine:

```bash
ssh -i "${ORY_DEPLOY_INPUTS_DIR:?}/github-deploy-ed25519" \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=${ORY_DEPLOY_INPUTS_DIR:?}/vps-known-hosts" \
  github-deploy@your-vps.example.com true
```

### 3. On the local machine: provision AWS with Terraform

Terraform creates two immutable private ECR repositories and three
repository/environment-scoped GitHub OIDC roles. It does not create IAM users or
long-lived AWS access keys.

```bash
cd infrastructure/terraform/aws-development
cp terraform.tfvars.example terraform.tfvars
${EDITOR:-vi} terraform.tfvars

terraform init
terraform fmt -check
terraform validate
terraform plan -out=ory-auth-development.tfplan
terraform apply ory-auth-development.tfplan
terraform output -json github_environment_variables
cd ../../..
```

For the same AWS account already used by daybook.cloud, keep
`create_github_oidc_provider=false` so Terraform references the existing
account-wide provider. Set it to `true` only when the AWS account does not yet
have the GitHub Actions OIDC provider. Review the plan before importing or
adopting any existing ECR repository or IAM role. See
`infrastructure/terraform/aws-development/README.md` for import commands and
state-management cautions.

### 4. On the local machine: configure GitHub in bulk

Create the three variable files:

```bash
install -d -m 700 tmp/github-environments
install -m 600 scripts/deploy/github-environments/ecr-build.vars.env.example \
  tmp/github-environments/ecr-build.vars.env
install -m 600 scripts/deploy/github-environments/development-auth.vars.env.example \
  tmp/github-environments/development-auth.vars.env
install -m 600 scripts/deploy/github-environments/development-admin.vars.env.example \
  tmp/github-environments/development-admin.vars.env
```

Copy the account ID, region, role ARNs, and ECR repository names from the
Terraform output into those files. Also set the VPS host, SSH port, deployment
user, and admin browser-public values. Do not put application secrets in the
variable files.

Generate the GitHub secret payload files without printing their contents:

```bash
export ORY_DEPLOY_INPUTS_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/ory-auth-apps/development"
scripts/deploy/prepare-github-environments.sh \
  "${ORY_DEPLOY_INPUTS_DIR:?}/auth-app.env" \
  "${ORY_DEPLOY_INPUTS_DIR:?}/ory.env" \
  "${ORY_DEPLOY_INPUTS_DIR:?}/admin-app.env" \
  "${ORY_DEPLOY_INPUTS_DIR:?}/github-deploy-ed25519" \
  "${ORY_DEPLOY_INPUTS_DIR:?}/vps-known-hosts" \
  "${ORY_DEPLOY_INPUTS_DIR:?}/host-release-signing-private.pem" \
  tmp/github-environments
```

This adds the same `HOST_RELEASE_SIGNING_PRIVATE_KEY_B64` secret to both
deployment environments. The private key never goes to the VPS; only the public
key installed during step 1.3 is present there.

Authenticate GitHub CLI, create/update the three environments, and upload all
variables and secrets in bulk:

```bash
gh auth status
scripts/deploy/configure-github-environments.sh \
  tociva/ory-auth-apps tmp/github-environments

gh variable list --repo tociva/ory-auth-apps --env ecr-build
gh variable list --repo tociva/ory-auth-apps --env development-auth
gh variable list --repo tociva/ory-auth-apps --env development-admin
gh secret list --repo tociva/ory-auth-apps --env development-auth
gh secret list --repo tociva/ory-auth-apps --env development-admin
```

In GitHub, open **Settings → Environments** and restrict `ecr-build`,
`development-auth`, and `development-admin` to the `development` branch. The
workflows also reject manual runs from any other branch.

Base64 is transport encoding, not encryption. After confirming the upload,
remove the generated payload copies from `tmp/` while retaining the protected
source files in the approved secret store.

### 5. First deployment: run auth, then admin

Commit the reviewed implementation and push it to `development` first. That
push normally starts both component workflows because the workflow and shared
deployment files changed.

Each workflow performs the following non-sudo VPS flow:

1. Build and test the combined backend/frontend image and push its immutable
   digest to ECR.
2. Create a release archive containing the checked-in Compose, deployment,
   validation, Nginx, and Kratos-rendering assets.
3. Sign that archive with `HOST_RELEASE_SIGNING_PRIVATE_KEY_B64`, then upload
   the archive/signature, runtime environment input, a short-lived ECR password,
   and (for auth) the Kratos configuration into
   `/var/lib/ory-auth/queue/incoming` as `github-deploy`.
4. Invoke `/usr/local/bin/submit-ory-release` over SSH without `sudo`.
5. Wait with `/usr/local/bin/wait-ory-release` while the root-owned systemd
   service validates/activates the bundle and performs the blue/green deploy.

The CI log includes the VPS processor log and fails if activation, migrations,
health checks, or deployment fail. A request ID combines `GITHUB_RUN_ID` and
`GITHUB_RUN_ATTEMPT`, so a workflow rerun is a distinct request.

Auth owns the Hydra/Kratos infrastructure and should be completed before admin
login is tested. If the initial push starts both workflows, their shared VPS
concurrency group serializes the deployment operations; wait for both to finish
and confirm auth is healthy before registering the admin OAuth client. For a
manual first run—or when a path-filtered push started neither workflow—start
auth and then admin:

```bash
gh workflow run deploy-auth-development.yml \
  --repo tociva/ory-auth-apps --ref development
# Select the newly started auth run when prompted.
gh run watch --repo tociva/ory-auth-apps --exit-status

gh workflow run deploy-admin-development.yml \
  --repo tociva/ory-auth-apps --ref development
# Select the newly started admin run when prompted.
gh run watch --repo tociva/ory-auth-apps --exit-status
```

If the new run is not listed immediately, wait a few seconds and repeat
`gh run watch`. Do not start admin until the auth run succeeds.

Later pushes to `development` trigger only the workflow whose component paths
changed. Both workflows share a VPS deployment lock/concurrency group, so auth
and admin cannot switch Nginx simultaneously.

### 6. One time after Hydra is running: register the admin OAuth client

Open an SSH tunnel from the local machine to Hydra's loopback-only admin port:

```bash
ssh -N -L 54445:127.0.0.1:4445 \
  your-vps-admin@your-vps.example.com
```

In a second local terminal, load the protected admin environment and register
the client. The client secret must match `ADMIN_OIDC_CLIENT_SECRET` deployed to
the admin container.

```bash
export ORY_DEPLOY_INPUTS_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/ory-auth-apps/development"
set -a
. "${ORY_DEPLOY_INPUTS_DIR:?}/admin-app.env"
set +a
export HYDRA_ADMIN_URL=http://127.0.0.1:54445
export AUTH_BASE_URL=https://auth-dev.idnest.cloud
node scripts/setup/provision-admin-client.js
```

Stop the SSH tunnel after the command succeeds. Rerun this step whenever the
admin client secret, redirect URIs, post-logout URIs, or client metadata change.

### 7. Verify the deployment

From the local machine:

```bash
curl --fail https://auth-dev.idnest.cloud/health
curl --fail https://auth-dev.idnest.cloud/auth/
curl --fail https://admin-dev.idnest.cloud/health
curl --fail https://admin-dev.idnest.cloud/config/config.json
curl --fail https://hydra-dev.idnest.cloud/.well-known/openid-configuration
curl --fail https://kratos-dev.idnest.cloud/health/ready
```

`https://admin-dev.idnest.cloud/config/config.json` must contain
`"apiBaseUrl":"/api"` and must not contain any secret, password, or DSN.

On the VPS:

```bash
sudo nginx -t
sudo systemctl status ory-auth-release-queue.path --no-pager
sudo systemctl status ory-auth-release-queue.service --no-pager
sudo docker compose --project-name ory-infra-development \
  --file /opt/ory-auth/ory/compose.yaml ps
sudo docker compose --project-name ory-auth-development \
  --file /opt/ory-auth/auth/compose.yaml \
  --env-file /opt/ory-auth/auth/release.env ps
sudo docker compose --project-name ory-admin-development \
  --file /opt/ory-auth/admin/compose.yaml \
  --env-file /opt/ory-auth/admin/release.env ps
sudo cat /opt/ory-auth/auth/state.env
sudo cat /opt/ory-auth/admin/state.env
sudo cat /opt/ory-auth/host-release.env
```

The state files should show the exact ECR digest, Git revision, active slot, and
deployment time. They contain deployment metadata, not application secrets.

### 8. Regular releases and configuration changes

- Push auth backend/frontend, Authz, or Kratos configuration changes to
  `development` to run the auth workflow.
- Push admin backend/frontend changes to `development` to run the admin
  workflow.
- After changing a GitHub environment secret or variable, manually rerun the
  corresponding workflow so the new runtime environment is installed.
- Compose, app deploy/rollback, validation, development Nginx, and render-script
  changes are transferred and activated automatically by either workflow; no
  manual VPS copy is needed.
- Repeat the manual checksum/bootstrap procedure only when one of the stable
  queue/bootstrap files listed in step 1.3 changes. This prevents CI from
  changing the mechanism that grants the queued release its root execution.
- Terraform is needed only when AWS repositories, IAM roles, trust conditions,
  or tags change.

Local pre-push verification remains available:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The former PM2/static-publishing commands remain available only as
`pnpm deploy:dev:legacy` and `pnpm frontends:publish:legacy`; they are not
compatible with the container-backed Nginx virtual hosts.

### 9. Roll back on the VPS

Rollback switches Nginx to the previously retained healthy application slot.
It does not reverse database migrations.

```bash
sudo /usr/local/sbin/rollback-ory-auth
sudo /usr/local/sbin/rollback-ory-admin
```

Verify the public health URL and the matching `/opt/ory-auth/*/state.env` after
every rollback.

## 7. Troubleshooting

### Local development service health and logs

These commands apply to the non-CI local development stack. For VPS health and
Compose commands, use step 7 of the deployment runbook above.

```bash
curl http://localhost:4445/health/ready
curl http://localhost:4433/health/ready
curl http://localhost:4000/health
curl http://localhost:4100/health
docker compose -f scripts/docker/docker-compose.yml ps
docker compose -f scripts/docker/docker-compose.yml logs ory-hydra ory-kratos
```

Inspect the Kratos configuration actually rendered inside its container:

```bash
docker exec ory-kratos cat /etc/config/kratos.yml
```

### nginx or certificate errors

```bash
nginx -t                       # macOS
sudo nginx -t                  # Linux
mkcert -CAROOT
```

Ensure `/etc/hosts` contains all four local Idnest hosts and that nginx points
to the certificate location created for the current OS.

### Kratos config did not update

```bash
docker compose -f scripts/docker/docker-compose.yml up -d --force-recreate ory-kratos
docker compose -f scripts/docker/docker-compose.yml logs ory-kratos
```

### Admin login is forbidden

- Confirm the login email is verified by Kratos.
- Confirm it matches `ADMIN_BOOTSTRAP_EMAILS` when no administrator exists.
- Confirm `ADMIN_OIDC_CLIENT_SECRET` matches the provisioned admin client.
- Confirm Authz migrations completed and `admin-backend` can reach
  `AUTHZ_DATABASE_URL`.
- If a deleted seeded identity still holds the only active administrator grant,
  run `node ./scripts/setup/provision-admin-client.js --repair-stale-admin-grants`.

### Force Google to show account selection

Visit `https://accounts.google.com/Logout`, then start the login flow again in a
new private browser window.

## 8. Security notes

- Never expose Hydra or Kratos admin ports publicly.
- Keep every `.env` and generated GitHub payload file out of version control.
- Rotate credentials that have ever been shared or committed.
- The admin browser holds only an opaque, HttpOnly BFF session cookie.
- Every admin API request revalidates the session, Kratos identity state,
  verified email, and active `system-admin` grant.
- The first-admin email allowlist is effective only while zero active system
  administrators exist.
- Product identities are federated through Google/Apple; provider logins without
  a verified email are rejected before tokens are issued.
- Social account linking uses Kratos's explicit account-settings flow rather
  than silently joining accounts by email.
- Hiding UI controls is not an authorization boundary; enforcement lives in
  `admin-backend`.
