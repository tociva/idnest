# Idnest Authentication Platform

Idnest is the authentication and identity platform used by `daybook.cloud`.
It is built upon Ory Hydra and Ory Kratos, with Express backends, Angular
frontends, PostgreSQL, and a shared authorization store in an Nx workspace.

This README is the single project guide. It covers the architecture, local
development, development deployment, common workflows, and security boundaries.

## Contents

- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Local development](#local-development)
- [Configuration](#configuration)
- [Common commands](#common-commands)
- [GitHub Actions development deployments](#github-actions-development-deployments)
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

The browser-facing local hostnames require a developer-managed, locally trusted
HTTPS gateway that maps them to the direct ports below. This repository does
not install or configure that gateway. The Express backends call the Hydra and
Kratos admin APIs directly; those privileged endpoints must never be
browser-accessible.

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
│   ├── deploy/                     # Development deployment and VPS bootstrap tooling
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

The repository intentionally contains no gateway-specific configuration.
Configure the HTTPS gateway of your choice with a locally trusted certificate
and these routes:

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

Manage the local Hydra and Kratos services directly when needed:

```bash
docker compose -f scripts/docker/docker-compose.yml up -d
docker compose -f scripts/docker/docker-compose.yml ps
docker compose -f scripts/docker/docker-compose.yml logs -f
docker compose -f scripts/docker/docker-compose.yml down
```

After changing `.env` or `config/kratos.tpl.yml`, recreate Kratos so the
generated configuration is refreshed:

```bash
docker compose -f scripts/docker/docker-compose.yml up -d --force-recreate kratos
```

## GitHub Actions development deployments

The development workflows submit signed auth, admin, and identity release
requests to the VPS. Auth and admin build multi-architecture images and publish
immutable digests to Amazon ECR. The separate identity workflow renders
`idnest.env`, migrates and starts Hydra and Kratos, and does not use AWS or ECR.
The VPS runs the root-owned release processor; the `github-deploy` SSH account
does not receive Docker or sudo access.

| Service | Public hostname | VPS HTTPS port |
| --- | --- | ---: |
| Auth | `auth-dev.idnest.cloud` | `8444` |
| Admin | `admin-dev.idnest.cloud` | `8445` |
| Hydra public API | `hydra-dev.idnest.cloud` | `8446` |
| Kratos public API | `kratos-dev.idnest.cloud` | `8447` |

All public development services use the `idnest.cloud` zone. The development
VPS SSH endpoint is `vps-dev.idnest.cloud`, while the four public service records
above remain proxied through Cloudflare.

Hydra admin `4445` and Kratos admin `4434` stay bound to loopback/private
network interfaces. The application containers terminate origin TLS directly.

Before starting, the development VPS must be running and reachable at
`65.108.158.243:22`. Create a **DNS-only** Cloudflare `A` record for
`vps-dev.idnest.cloud` pointing to `65.108.158.243`; never proxy this SSH
hostname. Keep the four proxied application records for step 6. Confirm that
the provider-created account can be reached with the workstation SSH key before
continuing.

The required order is: provision AWS, create deployment credentials, bootstrap
the VPS, prepare runtime values and databases, install Origin CA TLS, configure
public Cloudflare routing, upload GitHub settings, then deploy identity, auth,
and admin in that order.

### 1. Provision AWS with Terraform

Install Terraform, AWS CLI, GitHub CLI, `jq`, OpenSSL, and OpenSSH on a trusted
workstation. Authenticate AWS with permission to manage ECR, IAM roles and
policies, and the account-wide GitHub OIDC provider.

```bash
aws sts get-caller-identity
gh auth status

cp infrastructure/terraform/aws-development/terraform.tfvars.example \
  infrastructure/terraform/aws-development/terraform.tfvars
```

Open `infrastructure/terraform/aws-development/terraform.tfvars` with any
editor. The checked-in example contains the complete development configuration:

```hcl
aws_region        = "ap-south-1"
github_repository = "tociva/idnest"

build_environment_name = "ecr-build"
deploy_environment_names = {
  auth  = "development-auth"
  admin = "development-admin"
}

ecr_repository_names = {
  auth  = "idnest/auth-app"
  admin = "idnest/admin-app"
}

build_role_name = "idnest-development-build"
deploy_role_names = {
  auth  = "idnest-auth-development-deploy"
  admin = "idnest-admin-development-deploy"
}

create_github_oidc_provider   = false
create_ecr_repositories       = true
force_delete_ecr_repositories = false

github_deployment_targets = {
  development-auth = {
    vps_host = "vps-dev.idnest.cloud"
    vps_port = 22
    vps_user = "github-deploy"
  }
  development-admin = {
    vps_host = "vps-dev.idnest.cloud"
    vps_port = 22
    vps_user = "github-deploy"
  }
  development-identity = {
    vps_host = "vps-dev.idnest.cloud"
    vps_port = 22
    vps_user = "github-deploy"
  }
}

tags = {
  Project = "idnest"
}
```

Terraform also applies the provider-level tags `Application=idnest`,
`Environment=development`, and `ManagedBy=terraform` to supported AWS
resources. Values in `tags` are merged with those defaults.

These defaults reuse the account's existing GitHub OIDC provider and create the
two Idnest ECR repositories. AWS permits only one provider for
`https://token.actions.githubusercontent.com` in an account, so it is shared
with other projects. Set `create_github_oidc_provider=true` only in a new AWS
account where that provider does not exist. Change `create_ecr_repositories` to
`false` only if both named repositories already exist. Keep
`force_delete_ecr_repositories=false` for normal operation.

Idnest remains isolated through its own `idnest-*` IAM roles and ECR
repositories. Each role's trust policy also restricts tokens to the
`tociva/idnest` repository and the exact GitHub environment used by that role.

`vps-dev.idnest.cloud` is the direct SSH endpoint and is not routed through
Cloudflare. Auth, admin, and identity share this VPS but remain separate GitHub
deployment environments. `development-identity` receives only the VPS values;
it needs no AWS role because Hydra and Kratos use public upstream images.
`vps_user` is intentionally `github-deploy`: Terraform records it in the
validated output, and step 7 synchronizes it through `tmp/development.env` to
GitHub Actions, which must not connect as `root`.

This Terraform directory manages development only. Production will use a
separate Terraform directory, state, IAM roles, and GitHub environments. Only
`development-auth`, `development-admin`, and `development-identity` are valid
deployment targets here.

For a shared environment, configure the Terraform directory to use an encrypted
remote backend before initialization. After saving `terraform.tfvars`, run:

```bash
terraform -chdir=infrastructure/terraform/aws-development init
terraform -chdir=infrastructure/terraform/aws-development fmt
terraform -chdir=infrastructure/terraform/aws-development validate
terraform -chdir=infrastructure/terraform/aws-development plan \
  -out=idnest-deployment.tfplan
terraform -chdir=infrastructure/terraform/aws-development apply \
  idnest-deployment.tfplan
terraform -chdir=infrastructure/terraform/aws-development output \
  github_environment_variables
```

Run the output command only after a successful apply. Terraform reads outputs
from state, so `github_environment_variables` is unavailable when an apply
fails before the new state and outputs are committed.

### 2. Create development deployment credentials

Run the credential generator from the repository root on a trusted Mac. It
creates the sibling directory `../idnest-secure` with mode `0700`, generates the
deployment SSH and release-signing keypairs, captures the VPS SSH host keys, and
refuses to overwrite any existing credential:

```bash
./scripts/deploy/create-development-credentials.sh
```

The defaults are `vps-dev.idnest.cloud` and SSH port `22`. Pass a different
management endpoint explicitly when required:

```bash
./scripts/deploy/create-development-credentials.sh VPS_HOST VPS_PORT
```

The generated directory used by the following steps is:

```bash
DEPLOY_KEYS_DIR="../idnest-secure"
```

Verify the displayed VPS host-key fingerprint through a second trusted channel
before uploading the known-hosts value to GitHub.

Only the public halves are installed on the VPS: the deployment SSH public key
becomes `github-deploy`'s `authorized_keys`, and the release-signing public key
is installed as `/etc/idnest/host-release-signing-public.pem`. The two private
keys remain in the protected GitHub environment secrets prepared in step 7;
they are never installed on the VPS.

### 3. Bootstrap the development VPS

Use an approved administrative account with `sudo` access. SSH private-key
paths are workstation-specific and must not be stored in Terraform, GitHub
variables, or repository files. The VPS runner supports Debian and Ubuntu; when
Docker is absent, it configures Docker's official Apt repository and installs
Docker Engine with the Compose and Buildx plugins following the
[official Docker installation method](https://docs.docker.com/engine/install/ubuntu/).

When a new VPS has only the provider-created `root` account, run this one-time
administrator preparation script from the trusted Mac:

```bash
./scripts/deploy/prepare-development-vps-admin.sh \
  ~/.ssh/id_ed25519_hetzner_daybook_cloud
```

It defaults to creating `idnest-admin` on `vps-dev.idnest.cloud:22`, derives the
public half of the supplied SSH key locally, installs only that public key for
the new account, adds it to the standard `sudo` group, and verifies non-root SSH
and sudo before succeeding. It securely prompts for the new sudo password over
SSH; the password is not placed in command arguments or repository files. The
private key never leaves the Mac. Pass alternative values when needed:

```bash
./scripts/deploy/prepare-development-vps-admin.sh \
  ROOT_SSH_PRIVATE_KEY VPS_ADMIN_USER VPS_HOST VPS_PORT
```

This one-time preparation is the only repository script that logs in through
the provider `root` account. It does not disable provider root access, allowing
it to remain available for VPS recovery. Normal transfer, bootstrap, and GitHub
Actions deployment paths continue to reject `root`.

On the trusted Mac, run the transfer script from the repository root. Supply
the existing non-root administrative account and its workstation SSH private
key:

```bash
./scripts/deploy/transfer-development-vps-bootstrap.sh \
  idnest-admin \
  ~/.ssh/id_ed25519_hetzner_daybook_cloud
```

The defaults are `vps-dev.idnest.cloud` and SSH port `22`. Pass a different
management endpoint after the required arguments when necessary:

```bash
./scripts/deploy/transfer-development-vps-bootstrap.sh \
  VPS_ADMIN_USER VPS_ADMIN_SSH_KEY VPS_HOST VPS_PORT
```

The script creates the development-only archive and checksum under
`../idnest-secure`, creates `~/idnest-bootstrap` on the VPS, and transfers the
archive, checksum, VPS bootstrap runner, release-signing public key, and
deployment SSH public key. It then verifies both the archive and runner on the
VPS. Its explicit archive manifest excludes production files and local secrets.
It rejects `root` and `github-deploy` as the administrative account; use a
separate non-root account that already has `sudo` access. The administrative
key is not the generated `github-deploy` key.

Runtime secrets are never included in the bootstrap archive or transferred by
this script. The GitHub preparation helper in step 7 uses the ignored
`tmp/development.env` as the single protected source for configurable auth,
admin, Hydra, Kratos, Google, and optional Apple settings.

On the VPS, execute the transferred runner as that same non-root administrative
account:

```bash
~/idnest-bootstrap/bootstrap-development-vps.sh
```

The runner verifies all transferred checksums again before doing any
privileged work. It extracts a fresh repository tree, installs the minimum host
packages and Docker when missing, checks Docker Engine and the Compose plugin,
creates `github-deploy` when needed, provisions the release processor, and
installs missing development configuration templates. It invokes `sudo` only
for operations that require host privileges and refuses direct execution as
`root`.

### 4. Configure development runtime and databases

Perform this step after the VPS bootstrap and before installing TLS or starting
any workflow. The VPS owns deployment settings and TLS material, while the
trusted Mac owns the protected source used to populate GitHub settings.

#### Configure VPS-owned and GitHub-managed runtime files

The VPS owns deployment settings and TLS material. Review these three
root-owned configuration files after bootstrap:

- `/etc/idnest/auth.conf`
- `/etc/idnest/admin.conf`
- `/etc/idnest/idnest.conf`

Do not create or edit `/etc/idnest/idnest.env`, `/etc/idnest/auth-app.env`, or
`/etc/idnest/admin-app.env` manually. Each signed workflow generates its own
file from individual protected GitHub Environment settings. The root release
processor verifies the file and installs it as `root:root` mode `0600`.

The protected local source remains on the trusted Mac and only seeds individual
GitHub settings; the complete dotenv file is not stored as a GitHub secret.
`tmp/development.env` is the single source of truth for development key-value
settings. Create it now from the tracked example with mode `0600`. The command
refuses to overwrite an existing protected file:

```bash
test ! -e tmp/development.env || {
  echo "tmp/development.env already exists; refusing to overwrite it" >&2
  exit 1
}
install -d -m 700 tmp
install -m 600 scripts/deploy/env/development.env.example \
  tmp/development.env
```

The following is the complete copy-pasteable development file for a new setup.
Do not overwrite an existing protected file; add any missing properties while
preserving its current secrets. Values beginning with `replace-with-` are
placeholders and must be changed:

```dotenv
AWS_ACCOUNT_ID=replace-with-terraform-output
AWS_REGION=replace-with-terraform-output
AWS_BUILD_ROLE_ARN=replace-with-terraform-output
AUTH_AWS_DEPLOY_ROLE_ARN=replace-with-terraform-output
ADMIN_AWS_DEPLOY_ROLE_ARN=replace-with-terraform-output
AUTH_ECR_REPOSITORY=replace-with-terraform-output
ADMIN_ECR_REPOSITORY=replace-with-terraform-output
VPS_HOST=replace-with-terraform-output
VPS_PORT=replace-with-terraform-output
VPS_USER=replace-with-terraform-output
AUTH_URL=https://auth-dev.idnest.cloud
CORS_ALLOWED_ORIGINS=https://*.idnest.cloud,https://*.daybook.cloud
HYDRA_DSN=postgres://hydrau:replace-with-hydra-password@host.docker.internal:5432/hydra?sslmode=disable
HYDRA_URLS_SELF_ISSUER=https://hydra-dev.idnest.cloud/
HYDRA_URLS_CONSENT=https://auth-dev.idnest.cloud/oauth2/consent
HYDRA_URLS_LOGIN=https://auth-dev.idnest.cloud/oauth2/login
HYDRA_URLS_LOGOUT=https://auth-dev.idnest.cloud/logout
HYDRA_URLS_POST_LOGOUT_REDIRECT=https://admin-dev.idnest.cloud/auth/logout
HYDRA_URLS_ERROR=https://auth-dev.idnest.cloud/error
HYDRA_SECRETS_SYSTEM=replace-with-a-long-random-secret
KRATOS_DSN=postgres://kratosu:replace-with-kratos-password@host.docker.internal:5432/kratos?sslmode=disable
KRATOS_SERVE_PUBLIC_BASE_URL=https://kratos-dev.idnest.cloud
KRATOS_ADMIN_URL=http://localhost:4434
KRATOS_URLS_LOGOUT=https://hydra-dev.idnest.cloud/oauth2/sessions/logout
KRATOS_COOKIES_DOMAIN=.idnest.cloud
KRATOS_LOG_LEVEL=info
KRATOS_CSRF_COOKIE_SECRET=replace-with-a-long-random-secret
KRATOS_CIPHER_SECRET=replace-with-exactly-32-chars
GOOGLE_CLIENT_ID=replace-with-google-client-id
GOOGLE_CLIENT_SECRET=replace-with-google-client-secret
APPLE_CLIENT_ID=
APPLE_TEAM_ID=
APPLE_PRIVATE_KEY_ID=
APPLE_PRIVATE_KEY=
AUTHZ_DATABASE_URL=postgres://authzu:replace-with-authz-password@host.docker.internal:5432/authz?sslmode=disable
CONSENT_ACTION_SECRET=replace-with-a-long-random-secret
AUTH_TRANSACTION_SECRET=replace-with-a-32-byte-or-longer-random-secret
AUTH_AUDIT_HASH_SECRET=replace-with-an-independent-long-random-secret
ADMIN_BOOTSTRAP_EMAILS=replace-with-real-admin-email-address
ADMIN_CSRF_SECRET=replace-with-a-long-random-secret
ADMIN_OIDC_CLIENT_SECRET=replace-with-admin-client-secret
```

Keep all 41 properties. Do not enter the first ten infrastructure values by
hand: `update-development-env-from-terraform.sh` replaces their
`replace-with-terraform-output` placeholders from validated Terraform state.
Replace every remaining placeholder with its real value. Leave all four
`APPLE_*` values empty to disable Apple login, or configure all four together.
The helper validates the exact contract and rejects missing, duplicate,
unexpected, empty required, partial Apple, or placeholder values. Only
configurable values are uploaded; each workflow regenerates current
development defaults from tracked templates.

#### Terraform-derived infrastructure properties

These ten non-secret values are part of `tmp/development.env` so that it is the
only key-value input to the GitHub bulk updater. Do not maintain them in two
places. After applying Terraform, run the sync helper documented in step 7;
it validates all four Terraform environment objects, verifies their shared
AWS/VPS values agree, and atomically replaces only these properties without
printing any value.

| Property | Terraform source |
| --- | --- |
| `AWS_ACCOUNT_ID` | Active AWS account used by the development Terraform state. |
| `AWS_REGION` | Development `aws_region`. |
| `AWS_BUILD_ROLE_ARN` | GitHub OIDC build role for the `ecr-build` environment. |
| `AUTH_AWS_DEPLOY_ROLE_ARN` | Pull-only auth deployment role. |
| `ADMIN_AWS_DEPLOY_ROLE_ARN` | Pull-only admin deployment role. |
| `AUTH_ECR_REPOSITORY` | Auth image repository name. |
| `ADMIN_ECR_REPOSITORY` | Admin image repository name. |
| `VPS_HOST` | Shared development deployment hostname. |
| `VPS_PORT` | SSH port used by all three deployment workflows. |
| `VPS_USER` | Unprivileged deployment account, normally `github-deploy`. |

#### Development URL and behavior properties

These values come from the Idnest development domain layout. Keep the defaults
unless the corresponding public hostname or flow route intentionally changes.
The deployment renderers own these stable defaults, so changing only the local
file does not change a deployed URL. The validator rejects drift in these
properties; update the matching renderer, validator, and example together.

| Property | Default | Purpose and source |
| --- | --- | --- |
| `AUTH_URL` | `https://auth-dev.idnest.cloud` | Public auth UI/backend origin from the `auth-dev` DNS record. |
| `CORS_ALLOWED_ORIGINS` | `https://*.idnest.cloud,https://*.daybook.cloud` | Browser origins allowed to call Kratos; derived from the development product domains. |
| `HYDRA_URLS_SELF_ISSUER` | `https://hydra-dev.idnest.cloud/` | Public OAuth issuer. It must exactly match the URL clients use, including the trailing slash. |
| `HYDRA_URLS_CONSENT` | `https://auth-dev.idnest.cloud/oauth2/consent` | Auth backend endpoint Hydra uses for consent challenges. |
| `HYDRA_URLS_LOGIN` | `https://auth-dev.idnest.cloud/oauth2/login` | Auth backend endpoint Hydra uses for login challenges. |
| `HYDRA_URLS_LOGOUT` | `https://auth-dev.idnest.cloud/logout` | Auth backend endpoint Hydra uses for logout challenges. |
| `HYDRA_URLS_POST_LOGOUT_REDIRECT` | `https://admin-dev.idnest.cloud/auth/logout` | Default browser destination after Hydra logout. |
| `HYDRA_URLS_ERROR` | `https://auth-dev.idnest.cloud/error` | Public OAuth error page. |
| `KRATOS_SERVE_PUBLIC_BASE_URL` | `https://kratos-dev.idnest.cloud` | Public Kratos origin and the base used to form social-login callback URLs. |
| `KRATOS_ADMIN_URL` | `http://localhost:4434` | Admin API address inside the Kratos container; never expose this port publicly. |
| `KRATOS_URLS_LOGOUT` | `https://hydra-dev.idnest.cloud/oauth2/sessions/logout` | Hydra browser logout endpoint used after a Kratos logout. |
| `KRATOS_COOKIES_DOMAIN` | `.idnest.cloud` | Shared cookie domain covering the Idnest development subdomains. |
| `KRATOS_LOG_LEVEL` | `info` | Kratos runtime log verbosity; use `debug` only temporarily because logs can become noisy. |

#### Database and generated secret properties

Create three PostgreSQL roles and databases before deployment. Use a distinct,
URL-safe password for each role, then place it in the matching DSN. When
PostgreSQL runs on the VPS, `host.docker.internal` is the container-to-host
address configured by the deployment Compose files. For a managed database,
replace the host, port, and `sslmode` with values supplied by that provider.

| Property | How to obtain or generate it |
| --- | --- |
| `HYDRA_DSN` | Create PostgreSQL role `hydrau` and database `hydra`; build `postgres://hydrau:PASSWORD@host.docker.internal:5432/hydra?sslmode=disable`. |
| `KRATOS_DSN` | Create PostgreSQL role `kratosu` and database `kratos`; build `postgres://kratosu:PASSWORD@host.docker.internal:5432/kratos?sslmode=disable`. |
| `AUTHZ_DATABASE_URL` | Create PostgreSQL role `authzu` and database `authz`; build `postgres://authzu:PASSWORD@host.docker.internal:5432/authz?sslmode=disable`. The updater sends this one value to both auth and admin. |
| `HYDRA_SECRETS_SYSTEM` | Run `openssl rand -hex 32`; keep the value stable after Hydra has encrypted data with it. |
| `KRATOS_CSRF_COOKIE_SECRET` | Run `openssl rand -hex 32`; this produces a 64-character secret. |
| `KRATOS_CIPHER_SECRET` | Run `openssl rand -hex 16`; the result is exactly 32 characters, as required by the validator. |
| `CONSENT_ACTION_SECRET` | Run `openssl rand -hex 32`; used to sign consent actions. |
| `AUTH_TRANSACTION_SECRET` | Run `openssl rand -hex 32`; used to protect auth transaction state. |
| `AUTH_AUDIT_HASH_SECRET` | Run `openssl rand -hex 32`; use an independent value for audit hashing. |
| `ADMIN_CSRF_SECRET` | Run `openssl rand -hex 32`; used by the admin backend for CSRF protection. |
| `ADMIN_OIDC_CLIENT_SECRET` | Run `openssl rand -hex 32`, then use this exact value when provisioning the confidential `idnest-admin` Hydra client after the first admin deployment. |
| `ADMIN_BOOTSTRAP_EMAILS` | Enter the real, verified email allowed to receive initial system-admin access. Separate multiple emails with commas. |

Never reuse a database password, the VPS sudo password, an SSH passphrase, the
Cloudflare Origin CA private key, or another application secret. Do not rotate
Hydra/Kratos encryption secrets without first planning how existing encrypted
data will be handled.

#### Google social-login properties

In Google Cloud Console, configure the OAuth consent screen, then create an
OAuth 2.0 client with application type **Web application**. Register this exact
authorized redirect URI:

```text
https://kratos-dev.idnest.cloud/self-service/methods/oidc/callback/google
```

Google requires an exact redirect-URI match. Copy the resulting client ID into
`GOOGLE_CLIENT_ID` and client secret into `GOOGLE_CLIENT_SECRET`. Keep the
secret only in `tmp/development.env` and the protected GitHub Environment.
See Google's official
[web-server OAuth credential instructions](https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred).

#### Optional Apple social-login properties

To enable Apple, use an Apple Developer account to enable **Sign in with Apple**
for a primary App ID, create and configure a Services ID for the web integration,
and create a Sign in with Apple private key. Configure:

```text
Domain:     kratos-dev.idnest.cloud
Return URL: https://kratos-dev.idnest.cloud/self-service/methods/oidc/callback/apple
```

| Property | Apple Developer value |
| --- | --- |
| `APPLE_CLIENT_ID` | The Services ID identifier created for the web integration. |
| `APPLE_TEAM_ID` | The Team ID shown in Apple Developer membership details. |
| `APPLE_PRIVATE_KEY_ID` | The Key ID shown for the downloaded Sign in with Apple key. |
| `APPLE_PRIVATE_KEY` | The complete downloaded `.p8` private-key content encoded as one JSON string with `\n` escapes. Run `jq -Rs . < AuthKey_KEY_ID.p8` and paste its quoted output after `APPLE_PRIVATE_KEY=`. |

Apple displays the private-key download only once, so store the original `.p8`
outside the repository. See Apple's official guides for
[web configuration](https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web/)
and [creating a private key](https://developer.apple.com/help/account/capabilities/create-a-sign-in-with-apple-private-key).

| GitHub Environment | GitHub secrets | GitHub variables |
| --- | --- | --- |
| `ecr-build` | None | `AWS_ACCOUNT_ID`, `AWS_REGION`, `AWS_BUILD_ROLE_ARN`, `AUTH_ECR_REPOSITORY`, `ADMIN_ECR_REPOSITORY` |
| `development-auth` | `AUTHZ_DATABASE_URL`, `CONSENT_ACTION_SECRET`, `AUTH_TRANSACTION_SECRET`, `AUTH_AUDIT_HASH_SECRET` | `AWS_ACCOUNT_ID`, `AWS_REGION`, `AWS_DEPLOY_ROLE_ARN`, `ECR_REPOSITORY`, `VPS_HOST`, `VPS_PORT`, `VPS_USER`, `ADMIN_BOOTSTRAP_EMAILS` |
| `development-admin` | `AUTHZ_DATABASE_URL`, `ADMIN_CSRF_SECRET`, `ADMIN_OIDC_CLIENT_SECRET` | `AWS_ACCOUNT_ID`, `AWS_REGION`, `AWS_DEPLOY_ROLE_ARN`, `ECR_REPOSITORY`, `VPS_HOST`, `VPS_PORT`, `VPS_USER`, `ADMIN_BOOTSTRAP_EMAILS` |
| `development-identity` | `HYDRA_DSN`, `HYDRA_SECRETS_SYSTEM`, `KRATOS_DSN`, `KRATOS_CSRF_COOKIE_SECRET`, `KRATOS_CIPHER_SECRET`, `GOOGLE_CLIENT_SECRET`, optional `APPLE_PRIVATE_KEY_B64` | `VPS_HOST`, `VPS_PORT`, `VPS_USER`, `GOOGLE_CLIENT_ID`, optional `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, and `APPLE_PRIVATE_KEY_ID` |

All three deployment environments also receive the SSH private key, pinned
known-hosts file, and release-signing private key as separate base64 transport
secrets. Identity receives the shared VPS target but no AWS role because it
does not pull application images from ECR.

The single `AUTHZ_DATABASE_URL` and `ADMIN_BOOTSTRAP_EMAILS` values are uploaded
to both application environments. Generate independent random values for every
other secret. Provision the OAuth client with the same
`ADMIN_OIDC_CLIENT_SECRET` after the first admin workflow installs the generated
file.

The renderers hardcode development-only hostnames, internal service URLs, CORS
origins, cookie domain, log level, frontend paths, consent/branding modes,
transaction TTL, and boolean defaults from the tracked examples. Change the
renderer and examples together when one of those defaults intentionally
changes; these defaults are not GitHub settings.

Use URL-safe database passwords or percent-encode reserved URL characters.
Google client ID and secret are required. The helper validates an enabled Apple
private key and stores its raw bytes as the individual
`APPLE_PRIVATE_KEY_B64` GitHub secret.

The `.conf` defaults are already suitable for development:

| File | Important defaults |
| --- | --- |
| `auth.conf` | Compose project `idnest-auth-development`, `PUBLIC_HEALTH_URL=https://auth-dev.idnest.cloud/health`, origin port `8444`, network `idnest-runtime-development` |
| `admin.conf` | Compose project `idnest-admin-development`, `PUBLIC_HEALTH_URL=https://admin-dev.idnest.cloud/health`, origin port `8445`, network `idnest-runtime-development` |
| `idnest.conf` | Compose project `idnest-infra-development`, network `idnest-runtime-development`, Hydra origin `8446`, Hydra admin `4445`, Kratos origin `8447`, Kratos admin `4434` |

The public health URLs intentionally use normal HTTPS port `443`; Cloudflare
Origin Rules rewrite the origin connections to ports `8444` and `8445`. Change
the resource limits or ports only when the VPS or Cloudflare configuration also
changes.

Confirm the three VPS-owned `.conf` files are appropriate for this VPS, then
validate them:

```bash
~/idnest-bootstrap/bootstrap-development-vps.sh --validate-config
```

The signed identity workflow renders `idnest.env`, packages the tracked Kratos
configuration, signs both artifacts, and submits an `identity` request through
the protected queue. The root processor verifies every checksum and Ed25519
signature before installing anything. It atomically replaces the environment
and configuration, runs both migrations in one-off containers on
`idnest-runtime-development`, starts Hydra and Kratos, and checks their local
TLS readiness endpoints. Migration connectivity therefore confirms both DSNs
are reachable from Docker. If migration, build, or readiness fails, the prior
environment and Kratos configuration are restored together. A successful
database migration is not automatically reversed.

Auth and admin use the same signed environment-file mechanism for their own
settings. Auth no longer changes or starts Hydra or Kratos; it fails with a
clear instruction to run the identity workflow if either dependency is not
ready. Runner and queue copies of decoded secrets are deleted after each run.
Bootstrap preserves any existing pipeline-installed environment files.

Before the first workflow run, create the PostgreSQL roles, databases, and
schemas referenced by `HYDRA_DSN`, `KRATOS_DSN`, and `AUTHZ_DATABASE_URL`.
When PostgreSQL runs on the VPS, it must accept traffic from the Docker bridge
without exposing port `5432` publicly. The first identity release runs Hydra
and Kratos migrations, while the auth release runs the authorization migration;
neither creates database roles or databases. A managed database should be
prepared by its administrator.

### 5. Create and install a Cloudflare Origin CA certificate

In the Cloudflare dashboard, open **SSL/TLS → Origin Server → Create
Certificate**. Let Cloudflare generate the private key and CSR, select PEM
format, and create one Origin CA certificate containing these four exact SANs:

```text
auth-dev.idnest.cloud
admin-dev.idnest.cloud
hydra-dev.idnest.cloud
kratos-dev.idnest.cloud
```

Save both values immediately: Cloudflare displays the generated private key
only once. Use these filenames when transferring the files securely to the VPS:

| File | Source | Secret? |
| --- | --- | --- |
| `origin-cert.pem` | Cloudflare-generated Origin CA certificate | No |
| `origin-key.pem` | Cloudflare-generated matching private key | Yes |
| `origin-ca.pem` | Cloudflare Origin CA root for the selected key type | No |

Download the appropriate Origin CA root from Cloudflare's
[Origin CA documentation](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/).
Do not commit these files or store the origin private key in GitHub. Install the
three files by transferring them from the trusted Mac to the existing staging
directory. Set the same endpoint and administrative account used in step 3:

```bash
DEPLOY_KEYS_DIR="../idnest-secure"
CLOUDFLARE_FILES_DIR="/absolute/path/to/cloudflare-downloads"
DEVELOPMENT_VPS_HOST="vps-dev.idnest.cloud"
VPS_SSH_PORT=22
VPS_ADMIN_USER="replace-with-sudo-enabled-user"
VPS_ADMIN_SSH_KEY="/absolute/path/to/admin-ssh-private-key"

scp \
  -i "$VPS_ADMIN_SSH_KEY" \
  -P "$VPS_SSH_PORT" \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$DEPLOY_KEYS_DIR/vps-known-hosts" \
  "$CLOUDFLARE_FILES_DIR/origin-cert.pem" \
  "$CLOUDFLARE_FILES_DIR/origin-key.pem" \
  "$CLOUDFLARE_FILES_DIR/origin-ca.pem" \
  "$VPS_ADMIN_USER@$DEVELOPMENT_VPS_HOST:idnest-bootstrap/"
```

Then, on the VPS, install and validate them:

```bash
BOOTSTRAP_DIR="$HOME/idnest-bootstrap"
chmod 600 "$BOOTSTRAP_DIR/origin-key.pem"

sudo install -o root -g root -m 644 \
  "$BOOTSTRAP_DIR/origin-cert.pem" \
  /etc/idnest/tls/origin-cert.pem
sudo install -o root -g idnest-tls -m 640 \
  "$BOOTSTRAP_DIR/origin-key.pem" \
  /etc/idnest/tls/origin-key.pem
sudo install -o root -g root -m 644 \
  "$BOOTSTRAP_DIR/origin-ca.pem" \
  /etc/idnest/tls/origin-ca.pem

sudo openssl x509 -in /etc/idnest/tls/origin-cert.pem -noout \
  -subject -issuer -dates -ext subjectAltName
sudo openssl pkey -in /etc/idnest/tls/origin-key.pem -noout -check
for hostname in auth-dev.idnest.cloud admin-dev.idnest.cloud \
  hydra-dev.idnest.cloud kratos-dev.idnest.cloud; do
  sudo openssl x509 -in /etc/idnest/tls/origin-cert.pem \
    -noout -checkhost "$hostname"
done
sudo stat -c '%U:%G %a %n' /etc/idnest/tls/*
```

Set the zone's SSL/TLS encryption mode to
[**Full (strict)**](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)
only after the certificate and matching private key are installed. Origin CA
certificates authenticate Cloudflare-to-origin traffic and are not publicly
trusted browser certificates, so keep all four DNS records proxied.

### 6. Configure Cloudflare DNS and origin port rewrites

Confirm the DNS-only `vps-dev.idnest.cloud` management record created before
step 1 still points directly to `65.108.158.243`. Create proxied `A` records for
the four application hostnames pointing to `65.108.158.243`. Add `AAAA` records
only when IPv6 is configured and reachable on the VPS. Then create four
exact-hostname rules under **Rules → Origin Rules**. For each rule, set
**Destination port → Rewrite to**:

| Rule expression | Destination port |
| --- | ---: |
| `http.host eq "auth-dev.idnest.cloud"` | `8444` |
| `http.host eq "admin-dev.idnest.cloud"` | `8445` |
| `http.host eq "hydra-dev.idnest.cloud"` | `8446` |
| `http.host eq "kratos-dev.idnest.cloud"` | `8447` |

Cloudflare documents destination-port overrides in
[Origin Rules](https://developers.cloudflare.com/rules/origin-rules/examples/change-port/).
Browser URLs remain normal `https://...` URLs on port `443`; only Cloudflare's
connection to the VPS is rewritten.

Restrict VPS ports `8444`–`8447` to Cloudflare's current
[published IP ranges](https://www.cloudflare.com/ips/). Permit SSH only from
approved administration and CI sources. Never open Hydra admin `4445`, Kratos
admin `4434`, PostgreSQL `5432`, or Docker's socket to the public internet.

### 7. Configure GitHub environments

The successful Terraform apply in step 1 records the
`github_environment_variables` output, containing the four current environment
variable maps, in state. Synchronize their ten normalized non-secret AWS and
VPS values into the protected combined file:

```bash
./scripts/deploy/update-development-env-from-terraform.sh
```

To use non-default protected-file or Terraform locations, pass both in that
order:

```bash
./scripts/deploy/update-development-env-from-terraform.sh \
  /absolute/secure/path/development.env \
  /absolute/path/to/aws-development
```

The sync is the only command in this flow that reads Terraform output. It
validates cross-environment consistency and atomically updates only the ten
infrastructure properties in `tmp/development.env`; it preserves all
application values and does not contact GitHub. Whenever Terraform inputs or
outputs change later, repeat the plan/apply commands in step 1 before running
this sync; do not run an unplanned second apply here.

Review the protected file with your preferred editor, then validate the full
41-property contract:

```bash
./scripts/deploy/vps/validate-app-env.sh \
  tmp/development.env development-source
```

Finally run the bulk updater. It reads every key-value setting only from
`tmp/development.env`, prepares the named secrets and variables, creates or
updates `ecr-build`, `development-auth`, `development-admin`, and
`development-identity`, and securely deletes its temporary dotenv files:

```bash
./scripts/deploy/update-development-github-environments.sh
```

The default repository is `tociva/idnest`, and the default protected source is
`tmp/development.env`. Override either value when necessary:

```bash
./scripts/deploy/update-development-github-environments.sh \
  OWNER/REPOSITORY /absolute/secure/path/development.env
```

The selected mode-`0600` file is the only key-value input to the bulk updater.
When the default protected file is absent, the first run creates it from the
tracked combined template and exits before contacting GitHub. Fill its
application placeholders, run the Terraform sync helper, validate the file,
then run the bulk updater again. SSH private keys, known hosts, and the
release-signing key remain separate protected files because they are not
dotenv properties.

All three development deployment environments receive the transport secrets
`VPS_SSH_PRIVATE_KEY_B64`, `VPS_SSH_KNOWN_HOSTS_B64`, and
`HOST_RELEASE_SIGNING_PRIVATE_KEY_B64`. In addition:

- `development-auth` receives four named application secrets:
  `AUTHZ_DATABASE_URL`, `CONSENT_ACTION_SECRET`, `AUTH_TRANSACTION_SECRET`, and
  `AUTH_AUDIT_HASH_SECRET`.
- `development-admin` receives three named application secrets:
  `AUTHZ_DATABASE_URL`, `ADMIN_CSRF_SECRET`, and
  `ADMIN_OIDC_CLIENT_SECRET`.
- `development-identity` receives the five required Hydra/Kratos secrets, the
  Google client secret and ID variable, and the optional Apple group shown in
  the runtime table above.
- Auth and admin receive `ADMIN_BOOTSTRAP_EMAILS` as a non-secret GitHub Environment
  variable.

The `_B64` values use base64 encoding, not encryption. Named runtime values are
stored as separate GitHub secrets or variables; no full dotenv file is stored
in GitHub. The helpers validate file modes, key formats, exact
variable/secret names, and application environment contracts without printing
secret values. The bulk updater deletes its generated directory even when an
intermediate command fails. The configuration helper deletes obsolete
whole-file application secrets and removes stale optional Apple settings when
Apple login is disabled. After changing any protected local source file, rerun
the single bulk updater; the next matching deployment generates and installs
the new root-owned file on the VPS.

In **GitHub → Settings → Environments**, restrict `ecr-build`,
`development-auth`, `development-admin`, and `development-identity` to the
`development` branch. Add required reviewers where appropriate, and retain the
source keys only in the approved secret store.

### 8. Run and verify the first deployment

Run identity first. It installs `idnest.env`, migrates both target databases
from Docker, and starts Hydra and Kratos:

```bash
gh workflow run deploy-identity-development.yml \
  --repo tociva/idnest --ref development
gh run watch --repo tociva/idnest --exit-status
```

After identity succeeds, run auth:

```bash
gh workflow run deploy-auth-development.yml \
  --repo tociva/idnest --ref development
gh run watch --repo tociva/idnest --exit-status
```

After auth succeeds, run admin. This installs the GitHub-managed
`admin-app.env` and starts the admin service:

```bash
gh workflow run deploy-admin-development.yml \
  --repo tociva/idnest --ref development
gh run watch --repo tociva/idnest --exit-status
```

Then provision the confidential admin OAuth client once from the trusted
checkout on the VPS. The secret comes from the pipeline-installed
`admin-app.env`, the container joins the private Idnest network, and Node trusts
the installed Origin CA root:

```bash
cd ~/idnest-bootstrap/repository
sudo docker run --rm \
  --network idnest-runtime-development \
  --env-file /etc/idnest/admin-app.env \
  -e NODE_EXTRA_CA_CERTS=/run/idnest-tls/origin-ca.pem \
  --mount type=bind,src=/etc/idnest/tls/origin-ca.pem,dst=/run/idnest-tls/origin-ca.pem,readonly \
  --mount type=bind,src="$PWD/scripts/setup/provision-admin-client.js",dst=/work/provision-admin-client.js,readonly \
  node:22.22.0 node /work/provision-admin-client.js
```

Rerun that command whenever the admin client secret, redirect URIs, or client
metadata changes. If the secret changed, upload the updated GitHub Environment
first, run the admin workflow, and then provision the Hydra client with the same
new value.

Verify the public services through Cloudflare:

```bash
curl --fail https://auth-dev.idnest.cloud/health
curl --fail https://admin-dev.idnest.cloud/health
curl --fail https://hydra-dev.idnest.cloud/health/ready
curl --fail https://kratos-dev.idnest.cloud/health/ready
```

Run the matching workflow explicitly when a development release is ready. All
three workflows use the `idnest-vps-development` concurrency group. A DSN,
Hydra/Kratos secret, social-provider credential, or tracked Kratos configuration
change requires only the identity workflow. For VPS
diagnostics or rollback:

```bash
sudo systemctl status idnest-release-queue.path --no-pager
sudo journalctl -u idnest-release-queue.service -n 200 --no-pager
sudo ss -ltnp
sudo /usr/local/sbin/rollback-idnest-auth
sudo /usr/local/sbin/rollback-idnest-admin
```

Application rollback restores the previous image digest but does not reverse
database migrations. To restore a successful identity configuration, restore
the approved previous individual GitHub settings and rerun the identity
workflow; old plaintext identity environments are not retained on the VPS.

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
docker compose -f scripts/docker/docker-compose.yml logs hydra kratos
```

If a Kratos configuration change is not visible, force-recreate the
`idnest-kratos` container and inspect its logs.

For local certificate or gateway failures, verify the four `/etc/hosts`
entries, confirm the wildcard certificate is trusted, and check each route
against the direct upstream table in [Local development](#local-development).

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
