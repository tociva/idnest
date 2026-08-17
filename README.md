# Idnest Authentication Platform

Idnest is the authentication and identity platform used by `daybook.cloud`.
It combines Ory Hydra and Ory Kratos with Express backends, Angular frontends,
PostgreSQL, and a shared authorization store in an Nx workspace.

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

## GitHub Actions development deployments

The development workflows build multi-architecture auth and admin images, push
immutable digests to Amazon ECR, and submit signed release requests to the VPS.
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
Cloudflare. Auth and admin share this VPS but remain separate GitHub deployment
environments. `vps_user` is intentionally `github-deploy`: Terraform exports it
to GitHub Actions, which must not connect as `root`.

This Terraform directory manages development only. Production will use a
separate Terraform directory, state, IAM roles, and GitHub environments. If an
older state already contains production IAM resources from this directory, do
not apply this configuration until those resources are migrated to the future
production state; otherwise Terraform may propose destroying them.

When upgrading an older local `terraform.tfvars`, remove
`production_deploy_role_names`, `production-auth`, and `production-admin`.
Only `development-auth` and `development-admin` are valid deployment targets in
this directory.

After saving the file, run:

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

Keep Terraform state in an encrypted remote backend for shared environments.

### 2. Create development deployment credentials

Generate the keys outside the repository. The SSH key authenticates the
unprivileged release-submit account; the independent signing key authorizes the
root processor to activate checked-in host scripts.

```bash
DEPLOY_KEYS_DIR="/absolute/secure/path/idnest-development"
DEVELOPMENT_VPS_HOST="vps-dev.idnest.cloud"

install -d -m 700 "$DEPLOY_KEYS_DIR"
ssh-keygen -t ed25519 -a 64 -N '' \
  -f "$DEPLOY_KEYS_DIR/github-deploy-ed25519"
openssl genpkey -algorithm ED25519 \
  -out "$DEPLOY_KEYS_DIR/host-release-signing-private.pem"
openssl pkey \
  -in "$DEPLOY_KEYS_DIR/host-release-signing-private.pem" \
  -pubout \
  -out "$DEPLOY_KEYS_DIR/host-release-signing-public.pem"

ssh-keyscan -p 22 "$DEVELOPMENT_VPS_HOST" \
  > "$DEPLOY_KEYS_DIR/vps-known-hosts"
ssh-keygen -lf "$DEPLOY_KEYS_DIR/vps-known-hosts"
chmod 600 \
  "$DEPLOY_KEYS_DIR/github-deploy-ed25519" \
  "$DEPLOY_KEYS_DIR/host-release-signing-private.pem" \
  "$DEPLOY_KEYS_DIR/vps-known-hosts"
```

Verify the displayed VPS host-key fingerprint through a second trusted channel
before uploading the known-hosts value to GitHub.

Only the public halves are installed on the VPS: the deployment SSH public key
becomes `github-deploy`'s `authorized_keys`, and the release-signing public key
is installed as `/etc/idnest/host-release-signing-public.pem`. The two private
keys remain in the protected GitHub environment secrets prepared in step 6;
they are never installed on the VPS.

### 3. Bootstrap the development VPS

Install Docker Engine with the Compose plugin using Docker's official packages.
Connect using an approved administrative account with `sudo` access. SSH
private-key paths are workstation-specific and must not be stored in Terraform,
GitHub variables, or repository files.

On the trusted Mac, create the development-only bootstrap archive from the
repository root. The explicit file list excludes production examples and local
secrets:

```bash
BOOTSTRAP_ARCHIVE="idnest-development-vps-bootstrap.tar.gz"

tar -czf "$BOOTSTRAP_ARCHIVE" \
  scripts/deploy/vps/provision-host.sh \
  scripts/deploy/vps/compose.auth.yaml \
  scripts/deploy/vps/compose.admin.yaml \
  scripts/deploy/vps/compose.ory.yaml \
  scripts/deploy/vps/Dockerfile.kratos \
  scripts/deploy/vps/deploy-ory-app.sh \
  scripts/deploy/vps/deploy-ory-infra.sh \
  scripts/deploy/vps/deploy-ory-auth.sh \
  scripts/deploy/vps/deploy-ory-admin.sh \
  scripts/deploy/vps/rollback-ory-app.sh \
  scripts/deploy/vps/rollback-ory-auth.sh \
  scripts/deploy/vps/rollback-ory-admin.sh \
  scripts/deploy/vps/validate-app-env.sh \
  scripts/deploy/vps/activate-host-release.sh \
  scripts/deploy/vps/process-ory-release-queue.sh \
  scripts/deploy/vps/submit-ory-release.sh \
  scripts/deploy/vps/wait-ory-release.sh \
  scripts/deploy/vps/ory-auth-release-queue.path \
  scripts/deploy/vps/ory-auth-release-queue.service \
  scripts/deploy/vps/auth.conf.example \
  scripts/deploy/vps/admin.conf.example \
  scripts/deploy/vps/ory.conf.example \
  scripts/deploy/env/auth-app.env.example \
  scripts/deploy/env/admin-app.env.example \
  scripts/deploy/env/ory.env.example \
  scripts/docker/render-kratos-config.sh \
  config/kratos.tpl.yml \
  config/kratos/identity.schema.json \
  config/kratos/oidc.apple.mapper.jsonnet \
  config/kratos/oidc.google.mapper.jsonnet

shasum -a 256 "$BOOTSTRAP_ARCHIVE" > "$BOOTSTRAP_ARCHIVE.sha256"
```

Set the administrative SSH values. `VPS_ADMIN_USER` must be a non-root account
that already has `sudo` access; its SSH key is separate from the newly generated
`github-deploy` key:

```bash
DEVELOPMENT_VPS_HOST="vps-dev.idnest.cloud"
VPS_SSH_PORT=22
VPS_ADMIN_USER="replace-with-sudo-enabled-user"
VPS_ADMIN_SSH_KEY="/absolute/path/to/admin-ssh-private-key"

SSH_COMMON_OPTIONS=(
  -i "$VPS_ADMIN_SSH_KEY"
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$DEPLOY_KEYS_DIR/vps-known-hosts"
)

ssh "${SSH_COMMON_OPTIONS[@]}" -p "$VPS_SSH_PORT" \
  "$VPS_ADMIN_USER@$DEVELOPMENT_VPS_HOST" \
  'install -d -m 700 "$HOME/idnest-bootstrap"'

scp "${SSH_COMMON_OPTIONS[@]}" -P "$VPS_SSH_PORT" \
  "$BOOTSTRAP_ARCHIVE" \
  "$BOOTSTRAP_ARCHIVE.sha256" \
  "$DEPLOY_KEYS_DIR/host-release-signing-public.pem" \
  "$DEPLOY_KEYS_DIR/github-deploy-ed25519.pub" \
  "$VPS_ADMIN_USER@$DEVELOPMENT_VPS_HOST:idnest-bootstrap/"
```

On the VPS, verify and extract the archive before running anything from it:

```bash
BOOTSTRAP_DIR="$HOME/idnest-bootstrap"
BOOTSTRAP_ARCHIVE="idnest-development-vps-bootstrap.tar.gz"
REPOSITORY_DIR="$BOOTSTRAP_DIR/repository"

cd "$BOOTSTRAP_DIR"
sha256sum --check "$BOOTSTRAP_ARCHIVE.sha256"
install -d -m 700 "$REPOSITORY_DIR"
tar -xzf "$BOOTSTRAP_ARCHIVE" -C "$REPOSITORY_DIR"
cd "$REPOSITORY_DIR"
```

Run the minimum host setup from that extracted repository tree:

```bash
sudo apt update
sudo apt install -y ca-certificates curl openssl tar util-linux coreutils
sudo adduser --disabled-password --gecos '' github-deploy

sudo scripts/deploy/vps/provision-host.sh \
  github-deploy \
  ory-runtime-development \
  "$BOOTSTRAP_DIR/host-release-signing-public.pem" \
  "$BOOTSTRAP_DIR/github-deploy-ed25519.pub"

sudo systemctl status ory-auth-release-queue.path --no-pager
sudo test ! -e /etc/sudoers.d/ory-auth-deploy
```

Install the VPS-owned development environment files, replace every placeholder,
and validate them. These runtime secrets stay on the VPS and are not transferred
through GitHub Actions.

```bash
sudo install -o root -g root -m 600 \
  scripts/deploy/env/auth-app.env.example /etc/idnest/auth-app.env
sudo install -o root -g root -m 600 \
  scripts/deploy/env/admin-app.env.example /etc/idnest/admin-app.env
sudo install -o root -g root -m 600 \
  scripts/deploy/env/ory.env.example /etc/idnest/ory.env

sudoedit /etc/idnest/auth-app.env
sudoedit /etc/idnest/admin-app.env
sudoedit /etc/idnest/ory.env
sudoedit /etc/idnest/auth.conf
sudoedit /etc/idnest/admin.conf
sudoedit /etc/idnest/ory.conf

sudo /usr/local/sbin/validate-ory-app-env /etc/idnest/auth-app.env
sudo /usr/local/sbin/validate-ory-app-env /etc/idnest/admin-app.env
sudo /usr/local/sbin/validate-ory-app-env /etc/idnest/ory.env
sudo stat -c '%U:%G %a %n' /etc/idnest/*.env /etc/idnest/*.conf
```

Before the first workflow run, create the PostgreSQL roles, databases, and
schemas referenced by `HYDRA_DSN`, `KRATOS_DSN`, and `AUTHZ_DATABASE_URL`.
When PostgreSQL runs on the VPS, it must accept traffic from the Docker bridge
without exposing port `5432` publicly. The first auth release runs Hydra,
Kratos, and authorization migrations; it does not create the database roles or
databases. A managed database should be prepared by its administrator.

### 4. Create and install a Cloudflare Origin CA certificate

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
directory. Use the same Mac shell and SSH variables configured in step 3:

```bash
CLOUDFLARE_FILES_DIR="/absolute/path/to/cloudflare-downloads"

scp "${SSH_COMMON_OPTIONS[@]}" -P "$VPS_SSH_PORT" \
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

### 5. Configure Cloudflare DNS and origin port rewrites

Create proxied `A`/`AAAA` records for all four development hostnames pointing
to the VPS. Then create four exact-hostname rules under **Rules → Origin
Rules**. For each rule, set **Destination port → Rewrite to**:

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

### 6. Configure GitHub environments

Render Terraform's non-secret variables and prepare the two development secret
files. The helpers create/update only `ecr-build`, `development-auth`, and
`development-admin`:

```bash
GITHUB_REPOSITORY="tociva/idnest"
GITHUB_ENVIRONMENT_DIR="$(mktemp -d)"

scripts/deploy/render-github-environment-vars.sh \
  infrastructure/terraform/aws-development \
  "$GITHUB_ENVIRONMENT_DIR"

scripts/deploy/prepare-github-environments.sh \
  "$DEPLOY_KEYS_DIR/github-deploy-ed25519" \
  "$DEPLOY_KEYS_DIR/vps-known-hosts" \
  "$DEPLOY_KEYS_DIR/host-release-signing-private.pem" \
  "$GITHUB_ENVIRONMENT_DIR"

scripts/deploy/configure-github-environments.sh \
  "$GITHUB_REPOSITORY" \
  "$GITHUB_ENVIRONMENT_DIR"

gh variable list --repo "$GITHUB_REPOSITORY" --env ecr-build
gh variable list --repo "$GITHUB_REPOSITORY" --env development-auth
gh variable list --repo "$GITHUB_REPOSITORY" --env development-admin
gh secret list --repo "$GITHUB_REPOSITORY" --env development-auth
gh secret list --repo "$GITHUB_REPOSITORY" --env development-admin
```

The secret files contain base64 transport encoding, not encryption. The helper
validates file modes, key formats, exact variable/secret names, and placeholder
values without printing secrets.

In **GitHub → Settings → Environments**, restrict `ecr-build`,
`development-auth`, and `development-admin` to the `development` branch. Remove
the generated environment directory after confirming the upload; retain the
source keys only in the approved secret store.

### 7. Run and verify the first deployment

Run auth first because it also starts and migrates Hydra and Kratos:

```bash
gh workflow run deploy-auth-development.yml \
  --repo tociva/idnest --ref development
gh run watch --repo tociva/idnest --exit-status
```

After auth succeeds, provision the confidential admin OAuth client once from
the trusted checkout on the VPS. The secret comes from the already-installed
`admin-app.env`, the container joins the private Ory network, and Node trusts
the installed Origin CA root:

```bash
sudo docker run --rm \
  --network ory-runtime-development \
  --env-file /etc/idnest/admin-app.env \
  -e NODE_EXTRA_CA_CERTS=/run/ory-tls/origin-ca.pem \
  --mount type=bind,src=/etc/idnest/tls/origin-ca.pem,dst=/run/ory-tls/origin-ca.pem,readonly \
  --mount type=bind,src="$PWD/scripts/setup/provision-admin-client.js",dst=/work/provision-admin-client.js,readonly \
  node:22.22.0 node /work/provision-admin-client.js
```

Rerun that command whenever the admin client secret, redirect URIs, or client
metadata changes. Then deploy admin:

```bash
gh workflow run deploy-admin-development.yml \
  --repo tociva/idnest --ref development
gh run watch --repo tociva/idnest --exit-status
```

Verify the public services through Cloudflare:

```bash
curl --fail https://auth-dev.idnest.cloud/health
curl --fail https://admin-dev.idnest.cloud/health
curl --fail https://hydra-dev.idnest.cloud/health/ready
curl --fail https://kratos-dev.idnest.cloud/health/ready
```

Relevant pushes to `development` trigger the matching workflow automatically;
both workflows use the `idnest-vps-development` concurrency group. For VPS
diagnostics or rollback:

```bash
sudo systemctl status ory-auth-release-queue.path --no-pager
sudo journalctl -u ory-auth-release-queue.service -n 200 --no-pager
sudo ss -ltnp
sudo /usr/local/sbin/rollback-ory-auth
sudo /usr/local/sbin/rollback-ory-admin
```

Rollback restores the previous image digest but does not reverse database
migrations.

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
