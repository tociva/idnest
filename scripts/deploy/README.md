# Development Deployments

This guide covers the development deployment flow, protected environment source,
GitHub Environment synchronization, workflow execution, and deployment
verification.

## GitHub Actions development deployments

The development workflows submit signed auth, admin, and identity release
requests to the VPS. Auth and admin build native ARM64 images and publish
immutable digests to Amazon ECR. The separate identity workflow renders
`idnest.env`, migrates and starts Hydra and Kratos, and does not use AWS or ECR.
The VPS runs the root-owned release processor; the `idnest-deploy` SSH account
does not receive Docker or sudo access.

The deployment command surface is intentionally split by where the command
runs:

| Surface | Entrypoint | Purpose |
| --- | --- | --- |
| Trusted workstation | `scripts/deploy/transfer-development-vps-bootstrap.sh` | Build and upload the one-time VPS bootstrap payload |
| Development VPS | `~/idnest-bootstrap/bootstrap-development-vps.sh` | Verify the transferred payload and provision root-owned runtime scripts |
| GitHub Actions runner | `scripts/deploy/ci/prepare-release-request.sh` | Render/sign release artifacts and build the host-release archive from manifests |
| GitHub Actions runner | `scripts/deploy/ci/upload-release-request.sh` | Upload prepared artifacts into the unprivileged VPS queue |
| GitHub Actions runner | `scripts/deploy/ci/submit-release-request.sh` | Submit the queued request and wait for the root-owned processor |
| GitHub Actions runner | `scripts/deploy/ci/cleanup-release-request.sh` | Remove runner-side key material and signed release files |

The host-release archive contents are tracked in
`scripts/deploy/manifests/host-release-files.txt`. Identity configuration files
are tracked separately in `scripts/deploy/manifests/identity-config-files.txt`.
Workflows must call the helper scripts instead of embedding SSH, SCP, signing,
or archive commands directly in YAML; `pnpm test:deploy` enforces that contract.
The signed release queue scripts themselves are bootstrap-owned, as in the
Daybook backend: refresh the VPS bootstrap/provisioning path when the queue
protocol changes.

Development auth/admin releases use signed `app.env` files generated from
protected GitHub Environment settings. Production promotion is host-only by
design: it can promote an already tested image digest while reusing the
existing root-owned `/etc/idnest/auth-app.env` or `/etc/idnest/admin-app.env`
on the production VPS. A production host-only promotion fails before starting a
container if that environment file is absent or fails validation.

| Service | Public hostname | Loopback HTTP origin |
| --- | --- | ---: |
| Auth | `auth-dev.idnest.cloud` | `127.0.0.1:8444` |
| Admin | `admin-dev.idnest.cloud` | `127.0.0.1:8445` |
| Hydra public API | `hydra-dev.idnest.cloud` | `127.0.0.1:8446` |
| Kratos public API | `kratos-dev.idnest.cloud` | `127.0.0.1:8447` |

All public development services use the `idnest.cloud` zone. The development
VPS SSH endpoint is `vps-dev.idnest.cloud`, while the four public service records
above remain proxied through Cloudflare.

Hydra admin `4445` and Kratos admin `4434` are also loopback-only. A manually
managed Cloudflare Tunnel publishes the four public hostnames to these loopback
origins. Containers serve plain HTTP on the private Docker network; browsers
still use normal Cloudflare HTTPS endpoints.

Before starting, the development VPS must be running and reachable at
`VPS_PUBLIC_IP:22`, where `VPS_PUBLIC_IP` is the address assigned by the VPS
provider. Create a **DNS-only** Cloudflare `A` record for
`vps-dev.idnest.cloud` pointing to that address; never proxy this SSH hostname.
The four application hostnames are tunnel routes and do not point to the VPS
address. Confirm that the
provider-created account can be reached with the workstation SSH key before
continuing. Do not commit the actual address to this repository.

Follow the detailed guides in this order:

1. [Provision AWS with Terraform](../../infrastructure/terraform/aws-development/README.md)
2. [Create development deployment credentials](#create-development-deployment-credentials)
3. [Bootstrap the development VPS](vps/README.md)
4. [Configure development runtime and databases](#configure-development-runtime-and-databases)
5. [Validate public hostname routing](vps/README.md#validate-public-hostname-routing)
6. [Configure Hydra discovery CORS](#configure-hydra-discovery-cors)
7. [Configure GitHub environments](#configure-github-environments)
8. [Run and verify the first deployment](#run-and-verify-the-first-deployment)

## Create development deployment credentials

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
becomes `idnest-deploy`'s `authorized_keys`, and the release-signing public key
is installed as `/etc/idnest/host-release-signing-public.pem`. The two private
keys remain in the protected GitHub environment secrets prepared in
[Configure GitHub environments](#configure-github-environments); they are never
installed on the VPS.

Then create or refresh the protected combined development dotenv source:

```bash
./scripts/deploy/create-development-env.sh
```

This helper creates or reconciles `tmp/development.env` with mode `0600`,
atomically removing untracked keys, adding missing tracked keys, and refreshing
tracked development defaults. It generates any missing Hydra, Kratos, AuthZ,
admin, and delegation secrets and builds missing development database URLs
without rotating existing application values. If Terraform state is already
available, it imports the non-secret AWS and VPS values; otherwise those values
remain or are added as `replace-with-terraform-output` until
`update-development-env-from-terraform.sh` is run after Terraform apply.

Before Terraform output is available, the first eleven infrastructure fields may
remain `replace-with-terraform-output`. Apart from those tool-filled fields,
only values that require manual input remain as `replace-with-*`, such as
Google OAuth client values and the real bootstrap admin email address. Review
the file and replace those values before GitHub Environment upload.

## Configure development runtime and databases

Perform this step after the VPS bootstrap and before starting any workflow. The
VPS owns deployment settings and the tunnel connector, while the trusted Mac
owns the protected source used to populate GitHub settings.

### Configure VPS-owned and GitHub-managed runtime files

The VPS owns deployment settings. Review these three root-owned configuration
files after bootstrap:

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
settings. It is created by `create-development-env.sh` before bootstrap and may
be regenerated when development secrets must be rotated.

After running `create-development-env.sh`, generated secrets and database URLs
must already have concrete values. The only `replace-with-*` values that should
remain are the fields that come from Terraform output or human-controlled
external systems:

```dotenv
AWS_ACCOUNT_ID=replace-with-terraform-output
AWS_REGION=replace-with-terraform-output
AWS_BUILD_ROLE_ARN=replace-with-terraform-output
AUTH_AWS_DEPLOY_ROLE_ARN=replace-with-terraform-output
ADMIN_AWS_DEPLOY_ROLE_ARN=replace-with-terraform-output
AUTH_ECR_REPOSITORY=replace-with-terraform-output
ADMIN_ECR_REPOSITORY=replace-with-terraform-output
BUILDER_ECR_REPOSITORY=replace-with-terraform-output
VPS_HOST=replace-with-terraform-output
VPS_PORT=replace-with-terraform-output
VPS_USER=replace-with-terraform-output
GOOGLE_CLIENT_ID=replace-with-google-client-id
GOOGLE_CLIENT_SECRET=replace-with-google-client-secret
ADMIN_BOOTSTRAP_EMAILS=replace-with-real-admin-email-address
```

Keep every tracked property. Do not enter the first eleven infrastructure values
by hand: `create-development-env.sh` imports them when Terraform state is
available, and `update-development-env-from-terraform.sh` replaces any remaining
`replace-with-terraform-output` placeholders from validated Terraform state.
Replace every remaining placeholder with its real value. Leave all four
`APPLE_*` values empty to disable Apple login, or configure all four together.
The helper validates the exact contract and rejects missing, duplicate,
unexpected, empty required, partial Apple, or placeholder values. Only
configurable values are uploaded; each workflow regenerates current
development defaults from tracked templates.

### Generate development values

Use `create-development-env.sh` to generate independent values for local
development secrets and database URLs. The database passwords use hexadecimal
output so they are URL-safe in the DSNs without percent-encoding.
`KRATOS_CIPHER_SECRET` is generated as exactly 32 characters because Kratos
requires that length. The delegated authorization key is a dedicated P-256
PKCS#8 private key; do not reuse the release-signing key, Hydra secrets, or any
Apple private key.

For Apple login, keep all four `APPLE_*` values empty unless it is enabled. If
enabled, encode the downloaded `.p8` private key as one JSON string:

```bash
jq -Rs . < AuthKey_KEY_ID.p8
```

Paste the quoted output as the complete `APPLE_PRIVATE_KEY` value. The GitHub
Environment updater validates it and stores only `APPLE_PRIVATE_KEY_B64` in
`development-identity`.

### Terraform-derived infrastructure properties

These eleven non-secret values are part of `tmp/development.env` so that it is the
only key-value input to the GitHub bulk updater. Do not maintain them in two
places. After applying Terraform, run the sync helper documented in
[Configure GitHub environments](#configure-github-environments); it validates
all four Terraform environment objects, verifies their shared AWS/VPS values
agree, and atomically replaces only these properties without printing any
value.

| Property | Terraform source |
| --- | --- |
| `AWS_ACCOUNT_ID` | Active AWS account used by the development Terraform state. |
| `AWS_REGION` | Development `aws_region`. |
| `AWS_BUILD_ROLE_ARN` | GitHub OIDC build role for the `ecr-build` environment. |
| `AUTH_AWS_DEPLOY_ROLE_ARN` | Pull-only auth deployment role. |
| `ADMIN_AWS_DEPLOY_ROLE_ARN` | Pull-only admin deployment role. |
| `AUTH_ECR_REPOSITORY` | Auth image repository name. |
| `ADMIN_ECR_REPOSITORY` | Admin image repository name. |
| `BUILDER_ECR_REPOSITORY` | ARM64 dependency-builder image repository name. |
| `VPS_HOST` | Shared development deployment hostname. |
| `VPS_PORT` | SSH port used by all three deployment workflows. |
| `VPS_USER` | Unprivileged deployment account, normally `idnest-deploy`. |

### Development URL and behavior properties

These values come from the Idnest development domain layout. Keep the defaults
unless the corresponding public hostname or flow route intentionally changes.
The deployment renderers own these stable defaults, so changing only the local
file does not change a deployed URL. The validator rejects drift in these
properties; update the matching renderer, validator, and example together.

| Property | Default | Purpose and source |
| --- | --- | --- |
| `AUTH_URL` | `https://auth-dev.idnest.cloud` | Public auth UI/backend origin from the `auth-dev` DNS record. |
| `HYDRA_CORS_ALLOWED_ORIGINS` | `https://hydra-dev.idnest.cloud` | Infrastructure-only non-empty baseline for Hydra CORS. Product origins belong exclusively to their OAuth clients. Never use `*`. |
| `KRATOS_CORS_ALLOWED_ORIGINS` | `https://auth-dev.idnest.cloud` | Auth UI origin allowed to call Kratos. Kratos does not read Hydra client configuration. |
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
| `KRATOS_TOTP_ISSUER` | `Idnest Development` | Environment-specific label embedded in new authenticator enrollments so local, development, and production entries remain distinguishable. |

### Database and generated secret properties

Create three PostgreSQL roles and databases before deployment. Use a distinct,
URL-safe password for each role, then place it in the matching DSN. When
PostgreSQL runs on the VPS, `host.docker.internal` is the container-to-host
address configured by the deployment Compose files. For a managed database,
replace the host, port, and `sslmode` with values supplied by that provider.
The VPS bootstrap installs Docker; PostgreSQL setup is a separate step because
it uses database credentials from the protected development environment.

For PostgreSQL running on the development VPS, run the setup helper from the
trusted Mac after the VPS bootstrap runner has completed:

```bash
./scripts/deploy/setup-development-vps-postgres.sh \
  idnest-admin \
  /absolute/path/to/vps-admin-ssh-private-key \
  tmp/development.env
```

The helper reads `HYDRA_DSN`, `KRATOS_DSN`, and `AUTHZ_DATABASE_URL` from
`tmp/development.env`, installs PostgreSQL when missing, creates or updates the
matching roles and databases, configures PostgreSQL for the pinned Docker
runtime subnet, updates the active `pg_hba.conf`, restarts PostgreSQL, and
verifies container-to-host database connectivity. Run it from an interactive
terminal; the remote `sudo` commands may prompt for the `idnest-admin`
password. No separate `pg_hba.conf` edit is required after this helper succeeds.

If you are not using the helper, run these commands as a PostgreSQL
administrator after generating the three database passwords above:

```bash
sudo -u postgres psql \
  --set=hydra_password="$HYDRA_DB_PASSWORD" \
  --set=kratos_password="$KRATOS_DB_PASSWORD" \
  --set=authz_password="$AUTHZ_DB_PASSWORD" <<'SQL'
CREATE ROLE hydrau LOGIN PASSWORD :'hydra_password';
CREATE DATABASE hydra OWNER hydrau;

CREATE ROLE kratosu LOGIN PASSWORD :'kratos_password';
CREATE DATABASE kratos OWNER kratosu;

CREATE ROLE authzu LOGIN PASSWORD :'authz_password';
CREATE DATABASE authz OWNER authzu;
SQL
```

If PostgreSQL is managed by a provider, create equivalent roles/databases in
that provider and update the DSN host, port, and `sslmode` accordingly.

The development Docker runtime subnet is pinned to `172.23.0.0/16`. When
PostgreSQL runs on the same VPS and the development DSNs use
`sslmode=disable`, add these narrowly scoped records to the active
`pg_hba.conf`, validate `pg_hba_file_rules`, and reload PostgreSQL before the
first identity deployment:

```text
# Idnest development runtime network (pinned by bootstrap)
hostnossl  hydra   hydrau   172.23.0.0/16   scram-sha-256
hostnossl  kratos  kratosu  172.23.0.0/16   scram-sha-256
hostnossl  authz   authzu   172.23.0.0/16   scram-sha-256
```

Locate and validate the active host-based authentication file with:

```bash
sudo -u postgres psql -tAc 'SHOW hba_file;'
sudo -u postgres psql -c "SELECT line_number, type, database, user_name, address, auth_method, error FROM pg_hba_file_rules WHERE database && ARRAY['hydra','kratos','authz'];"
sudo systemctl reload postgresql
```

Do not copy this CIDR blindly to another environment. The generic host
provisioner requires an explicit `RUNTIME_SUBNET` argument and verifies the
created or existing network against it. Reserve a different, non-overlapping
CIDR for staging and production, then configure only that environment's
database access for its reserved CIDR. Check existing Docker networks, host
routes, VPC routes, and VPN routes before assigning a new subnet.

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
| `DELEGATION_ENABLED` | Keep `false` while configuring resources and clients. Change to `true` only after the broker key and policies are ready. |
| `DELEGATION_SIGNING_PRIVATE_KEY_B64` | Generate a dedicated P-256 PKCS#8 key with `openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out delegation-private.pem`, then run `openssl base64 -A -in delegation-private.pem`. Store the one-line result here; never reuse the Hydra or release-signing key. |
| `ADMIN_CSRF_SECRET` | Run `openssl rand -hex 32`; used by the admin backend for CSRF protection. |
| `ADMIN_OIDC_CLIENT_SECRET` | Run `openssl rand -hex 32`, then use this exact value when provisioning the confidential `idnest-admin` Hydra client after the first admin deployment. |
| `ADMIN_BOOTSTRAP_EMAILS` | Enter the real, verified email allowed to receive initial system-admin access. Separate multiple emails with commas. |

Never reuse a database password, the VPS sudo password, an SSH passphrase, or
another application secret. Do not rotate Hydra/Kratos encryption secrets
without first planning how existing encrypted data will be handled.

### Google social-login properties

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

### Optional Apple social-login properties

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

### GitHub Environment contract

These are the exact GitHub Environment variables and secrets prepared from
`tmp/development.env` and `../idnest-secure`. Values not listed here are not
required by the development workflows.

| GitHub Environment | GitHub secrets | GitHub variables |
| --- | --- | --- |
| `ecr-build` | None | `AWS_ACCOUNT_ID`, `AWS_REGION`, `AWS_BUILD_ROLE_ARN`, `AUTH_ECR_REPOSITORY`, `ADMIN_ECR_REPOSITORY`, `BUILDER_ECR_REPOSITORY` |
| `development-auth` | `VPS_SSH_PRIVATE_KEY_B64`, `VPS_SSH_KNOWN_HOSTS_B64`, `HOST_RELEASE_SIGNING_PRIVATE_KEY_B64`, `AUTHZ_DATABASE_URL`, `CONSENT_ACTION_SECRET`, `AUTH_TRANSACTION_SECRET`, `AUTH_AUDIT_HASH_SECRET`, `DELEGATION_SIGNING_PRIVATE_KEY_B64` | `AWS_ACCOUNT_ID`, `AWS_REGION`, `AWS_DEPLOY_ROLE_ARN`, `ECR_REPOSITORY`, `VPS_HOST`, `VPS_PORT`, `VPS_USER`, `ADMIN_BOOTSTRAP_EMAILS`, `DELEGATION_ENABLED` |
| `development-admin` | `VPS_SSH_PRIVATE_KEY_B64`, `VPS_SSH_KNOWN_HOSTS_B64`, `HOST_RELEASE_SIGNING_PRIVATE_KEY_B64`, `AUTHZ_DATABASE_URL`, `ADMIN_CSRF_SECRET`, `ADMIN_OIDC_CLIENT_SECRET` | `AWS_ACCOUNT_ID`, `AWS_REGION`, `AWS_DEPLOY_ROLE_ARN`, `ECR_REPOSITORY`, `VPS_HOST`, `VPS_PORT`, `VPS_USER`, `ADMIN_BOOTSTRAP_EMAILS` |
| `development-identity` | `VPS_SSH_PRIVATE_KEY_B64`, `VPS_SSH_KNOWN_HOSTS_B64`, `HOST_RELEASE_SIGNING_PRIVATE_KEY_B64`, `HYDRA_DSN`, `HYDRA_SECRETS_SYSTEM`, `KRATOS_DSN`, `KRATOS_CSRF_COOKIE_SECRET`, `KRATOS_CIPHER_SECRET`, `GOOGLE_CLIENT_SECRET`, optional `APPLE_PRIVATE_KEY_B64` | `VPS_HOST`, `VPS_PORT`, `VPS_USER`, `GOOGLE_CLIENT_ID`, optional `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, and `APPLE_PRIVATE_KEY_ID` |

Identity receives the shared VPS target but no AWS role because it does not
pull application images from ECR.

The single `AUTHZ_DATABASE_URL` and `ADMIN_BOOTSTRAP_EMAILS` values are uploaded
to both application environments. Generate independent random values for every
other secret. Provision the OAuth client with the same
`ADMIN_OIDC_CLIENT_SECRET` after the first admin workflow installs the generated
file.

The renderers hardcode development-only hostnames, internal service URLs, CORS
origins, cookie domain, log level, frontend paths, consent/branding modes,
transaction TTL, delegation issuer/audience/key ID/grant TTL, and most boolean defaults from the tracked examples. Change the
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

The public health URLs intentionally use normal HTTPS port `443`; the manually
managed Cloudflare Tunnel forwards each hostname to its loopback HTTP port.
Change resource limits or ports only when the matching tunnel route and tracked
host configuration also change. Confirm the three VPS-owned `.conf` files are
appropriate, then rerun the host validator:

```bash
sudo /usr/local/sbin/validate-idnest-development-host
```

The signed identity workflow renders `idnest.env`, packages the tracked Kratos
configuration, signs both artifacts, and submits an `identity` request through
the protected queue. The root processor verifies every checksum and Ed25519
signature before installing anything. It atomically replaces the environment
and configuration, runs both migrations in one-off containers on
`idnest-runtime-development`, starts Hydra and Kratos, and checks their local
loopback HTTP readiness endpoints. Migration connectivity therefore confirms both DSNs
are reachable from Docker. If migration, build, or readiness fails, the prior
environment and Kratos configuration are restored together. A successful
database migration is not automatically reversed.

Auth and admin use the same signed environment-file mechanism for their own
settings. Auth no longer changes or starts Hydra or Kratos; it fails with a
clear instruction to run the identity workflow if either dependency is not
ready. Runner and queue copies of decoded secrets are deleted after each run.
Bootstrap preserves any existing pipeline-installed environment files.

The auth, admin, and identity validation jobs run the tracked CORS contract
check before building or deploying. The admin validation job additionally
starts an isolated Hydra v26.2.0 container and proves that exact per-client
origins are enforced. After an identity deployment, the identity workflow
checks the public Cloudflare route and fails if wildcard CORS is missing from
metadata or leaks onto token or userinfo routes.

Before the first workflow run, create the PostgreSQL roles, databases, and
schemas referenced by `HYDRA_DSN`, `KRATOS_DSN`, and `AUTHZ_DATABASE_URL`.
When PostgreSQL runs on the VPS, it must accept traffic from the Docker bridge
without exposing port `5432` publicly. The first identity release runs Hydra
and Kratos migrations, while the auth release runs the authorization migration;
neither creates database roles or databases. A managed database should be
prepared by its administrator.

## Configure Hydra discovery CORS

OIDC discovery and signing keys are intentionally public and their requests do
not contain a client ID. Under **Rules → Overview**, create one **Response
Header Transform Rule** named `Hydra public metadata CORS` with this expression:

```text
(
  http.host eq "hydra-dev.idnest.cloud"
  and http.request.method in {"GET" "HEAD" "OPTIONS"}
  and http.request.uri.path in {
    "/.well-known/openid-configuration"
    "/.well-known/oauth-authorization-server"
    "/.well-known/jwks.json"
  }
)
```

Configure three response-header operations:

| Operation | Header | Value |
| --- | --- | --- |
| Set static | `Access-Control-Allow-Origin` | `*` |
| Set static | `Access-Control-Allow-Methods` | `GET, HEAD, OPTIONS` |
| Remove | `Access-Control-Allow-Credentials` | — |

Use **Set static**, not **Add**, so an upstream header cannot produce a
duplicate value. Do not broaden this expression to `/oauth2/token`,
`/userinfo`, `/oauth2/revoke`, or `/oauth2/sessions/*`.

## Configure GitHub environments

The successful Terraform apply records the
`github_environment_variables` output, containing the four current environment
variable maps, in state. Synchronize their eleven normalized non-secret AWS and
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
validates cross-environment consistency and atomically updates only the eleven
infrastructure properties in `tmp/development.env`; it preserves all
application values and does not contact GitHub. Whenever Terraform inputs or
outputs change later, repeat the plan/apply commands in the
[AWS development Terraform guide](../../infrastructure/terraform/aws-development/README.md)
before running this sync; do not run an unplanned second apply here.

Review the protected file with your preferred editor, then validate the full
tracked property contract:

```bash
./scripts/deploy/vps/validate-app-env.sh \
  tmp/development.env development-source
```

Finally run the bulk updater. It reads every key-value setting only from
`tmp/development.env`, prepares the named secrets and variables, creates or
updates `ecr-build`, `development-auth`, `development-admin`, and
`development-identity`, prunes unlisted variables and secrets from those
development environments, and securely deletes its temporary dotenv files:

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

- `development-auth` receives five named application secrets:
  `AUTHZ_DATABASE_URL`, `CONSENT_ACTION_SECRET`, `AUTH_TRANSACTION_SECRET`, and
  `AUTH_AUDIT_HASH_SECRET`, plus the independent
  `DELEGATION_SIGNING_PRIVATE_KEY_B64`. It also receives the configurable
  `DELEGATION_ENABLED` variable.
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
intermediate command fails. The configuration helper removes obsolete
whole-file application secrets, stale optional Apple settings when Apple login
is disabled, and any other unlisted environment variable or secret in the four
development environments. After changing any protected local source file, rerun
the single bulk updater; the next matching deployment generates and installs
the new root-owned file on the VPS.

In **GitHub → Settings → Environments**, restrict `ecr-build`,
`development-auth`, `development-admin`, and `development-identity` to the
`development` branch. Add required reviewers where appropriate, and retain the
source keys only in the approved secret store.

## Run and verify the first deployment

Run identity first. It installs `idnest.env`, migrates both target databases
from Docker, and starts Hydra and Kratos:

```bash
gh workflow run deploy-identity-development.yml \
  --repo tociva/idnest --ref development
gh run watch --repo tociva/idnest --exit-status
```

After identity succeeds, bootstrap or verify the dependency-builder image. This
is normally already created by changes to dependency inputs, and the auth/admin
workflows also ensure it exists before compiling:

```bash
gh workflow run build-builder-base-development.yml \
  --repo tociva/idnest --ref development
gh run watch --repo tociva/idnest --exit-status
```

Then run auth:

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

To redeploy an existing auth or admin image without rebuilding, list published
tags and run the rollback workflow. `version` may be the immutable ECR tag
`git-<sha>-<run_id>-<attempt>` or a `sha256:...` digest. Host deploy still runs
the selected image's migrations and does not reverse a newer schema:

```bash
aws ecr describe-images --region ap-south-1 --repository-name idnest/auth-app \
  --query 'reverse(sort_by(imageDetails,&imagePushedAt))[:10].[imageTags[0],imageDigest]' \
  --output table

gh workflow run rollback-development.yml \
  --repo tociva/idnest --ref development \
  -f component=auth \
  -f version=git-60675f30240111395d473c27a4db3cbcef143357-32227106470-1
gh run watch --repo tociva/idnest --exit-status
```

Use `idnest/admin-app` and `component=admin` to roll back admin.

The admin deployment provisions or updates the confidential admin OAuth client
from the pipeline-installed `admin-app.env`. No separate first-admin client
bootstrap step is required after a successful admin release.

For an exceptional manual repair, rerun the same provisioner from the active
admin image on the VPS. The secret comes from `admin-app.env`, and the
container joins the private Idnest network:

```bash
sudo docker run --rm \
  --network idnest-runtime-development \
  --env-file /etc/idnest/admin-app.env \
  "$(awk -F= '$1 == "ACTIVE_IMAGE" { print $2 }' /opt/idnest/admin/state.env)" \
  node scripts/setup/provision-admin-client.js
```

If the secret changed, upload the updated GitHub Environment first and run the
admin workflow; the deployment updates the Hydra client with the same new
value.

Verify the public services through Cloudflare:

```bash
curl --fail https://auth-dev.idnest.cloud/health
curl --fail https://admin-dev.idnest.cloud/health
curl --fail https://hydra-dev.idnest.cloud/health/ready
curl --fail https://kratos-dev.idnest.cloud/health/ready
```

Run the matching workflow explicitly when a development release is ready. The
identity, auth, admin, and rollback workflows share the `idnest-vps-development`
concurrency group. A DSN, Hydra/Kratos secret, social-provider credential, or
tracked Kratos configuration change requires only the identity workflow. For VPS
diagnostics or a one-generation previous-image rollback:

```bash
sudo systemctl status idnest-release-queue.path --no-pager
sudo journalctl -u idnest-release-queue.service -n 200 --no-pager
sudo ss -ltnp
sudo /usr/local/sbin/rollback-idnest-auth
sudo /usr/local/sbin/rollback-idnest-admin
```

The VPS command restores only the immediately previous image digest. The
GitHub rollback workflow can select any image that still exists in ECR. Neither
path reverses database migrations. To restore a successful identity
configuration, restore the approved previous individual GitHub settings and
rerun the identity workflow; old plaintext identity environments are not
retained on the VPS.
