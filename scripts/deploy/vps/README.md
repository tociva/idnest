# Direct-TLS VPS deployment runbook

This is the authoritative AWS, GitHub, Cloudflare, and VPS deployment runbook.
The VPS does not require Nginx. Auth, admin, Hydra, and Kratos terminate the
Cloudflare-to-origin TLS connection directly on fixed ports.

| Service | Development hostname | Production hostname | VPS HTTPS port |
| --- | --- | --- | ---: |
| Auth | `auth-dev.idnest.cloud` | `auth.idnest.cloud` | `8444` |
| Admin | `admin-dev.idnest.cloud` | `admin.idnest.cloud` | `8445` |
| Hydra public | `hydra-dev.idnest.cloud` | `hydra.idnest.cloud` | `8446` |
| Kratos public | `kratos-dev.idnest.cloud` | `kratos.idnest.cloud` | `8447` |

Hydra admin `4445` is HTTPS and loopback/private-network only. Kratos admin
`4434` remains HTTP but is loopback/private-network only. Development and
production may use separate VPS hosts while sharing immutable ECR repositories.

## 1. Workstation prerequisites

Install Terraform, AWS CLI, GitHub CLI, `jq`, OpenSSL, and OpenSSH. Authenticate
AWS with an administrator role and authenticate GitHub CLI with permission to
manage repository Actions environments, variables, and secrets.

```sh
terraform version
aws --version
gh --version
jq --version
openssl version
ssh -V
aws sts get-caller-identity
gh auth status
```

Create a protected local directory. Do not store these inputs in the repository.

```sh
export ORY_DEPLOY_INPUTS_ROOT="${XDG_CONFIG_HOME:-${HOME}/.config}/ory-auth-apps"
install -d -m 700 \
  "${ORY_DEPLOY_INPUTS_ROOT:?}/development" \
  "${ORY_DEPLOY_INPUTS_ROOT:?}/production"
```

## 2. Generate independent deployment credentials

Generate one SSH key and one release-signing key for each environment:

```sh
ssh-keygen -t ed25519 -a 64 -N '' \
  -f "${ORY_DEPLOY_INPUTS_ROOT:?}/development/github-deploy-ed25519"
openssl genpkey -algorithm ED25519 \
  -out "${ORY_DEPLOY_INPUTS_ROOT:?}/development/host-release-signing-private.pem"
openssl pkey \
  -in "${ORY_DEPLOY_INPUTS_ROOT:?}/development/host-release-signing-private.pem" \
  -pubout \
  -out "${ORY_DEPLOY_INPUTS_ROOT:?}/development/host-release-signing-public.pem"

ssh-keygen -t ed25519 -a 64 -N '' \
  -f "${ORY_DEPLOY_INPUTS_ROOT:?}/production/github-deploy-ed25519"
openssl genpkey -algorithm ED25519 \
  -out "${ORY_DEPLOY_INPUTS_ROOT:?}/production/host-release-signing-private.pem"
openssl pkey \
  -in "${ORY_DEPLOY_INPUTS_ROOT:?}/production/host-release-signing-private.pem" \
  -pubout \
  -out "${ORY_DEPLOY_INPUTS_ROOT:?}/production/host-release-signing-public.pem"

chmod 600 \
  "${ORY_DEPLOY_INPUTS_ROOT:?}/development/github-deploy-ed25519" \
  "${ORY_DEPLOY_INPUTS_ROOT:?}/development/host-release-signing-private.pem" \
  "${ORY_DEPLOY_INPUTS_ROOT:?}/production/github-deploy-ed25519" \
  "${ORY_DEPLOY_INPUTS_ROOT:?}/production/host-release-signing-private.pem"
```

Capture each VPS host key and verify its fingerprint through a second trusted
channel before using it:

```sh
ssh-keyscan -p 22 development-vps.example.net \
  >"${ORY_DEPLOY_INPUTS_ROOT:?}/development/vps-known-hosts"
ssh-keyscan -p 22 production-vps.example.net \
  >"${ORY_DEPLOY_INPUTS_ROOT:?}/production/vps-known-hosts"
ssh-keygen -lf "${ORY_DEPLOY_INPUTS_ROOT:?}/development/vps-known-hosts"
ssh-keygen -lf "${ORY_DEPLOY_INPUTS_ROOT:?}/production/vps-known-hosts"
chmod 600 \
  "${ORY_DEPLOY_INPUTS_ROOT:?}/development/vps-known-hosts" \
  "${ORY_DEPLOY_INPUTS_ROOT:?}/production/vps-known-hosts"
```

## 3. Bootstrap each VPS once

Install Docker Engine with the Compose plugin, `curl`, OpenSSL, `tar`,
`util-linux`, and `coreutils`. Create an unprivileged deployment user without
Docker-group membership.

```sh
sudo apt update
sudo apt install -y ca-certificates curl openssl tar util-linux coreutils
sudo adduser --disabled-password --gecos '' github-deploy
docker --version
docker compose version
id github-deploy
```

Copy the matching public keys to a temporary root-readable location and run the
provisioner from a trusted checkout. On the development VPS:

```sh
sudo scripts/deploy/vps/provision-host.sh \
  github-deploy \
  ory-runtime-development \
  /secure/development/host-release-signing-public.pem \
  /secure/development/github-deploy-ed25519.pub
```

On the production VPS:

```sh
sudo scripts/deploy/vps/provision-host.sh \
  github-deploy \
  ory-runtime-production \
  /secure/production/host-release-signing-public.pem \
  /secure/production/github-deploy-ed25519.pub
```

Provisioning installs the root-owned Compose/deploy/rollback assets, private
release queue, systemd queue processor, and `ory-auth-tls` group. GitHub Actions
can submit signed requests but cannot access Docker or invoke arbitrary root
commands.

Verify the queue watcher:

```sh
sudo systemctl status ory-auth-release-queue.path --no-pager
sudo test ! -e /etc/sudoers.d/ory-auth-deploy
id github-deploy
```

## 4. Install VPS-owned runtime configuration

For development, copy these templates on the development VPS:

```sh
sudo install -o root -g root -m 600 \
  scripts/deploy/env/auth-app.env.example /etc/ory-auth/auth-app.env
sudo install -o root -g root -m 600 \
  scripts/deploy/env/admin-app.env.example /etc/ory-auth/admin-app.env
sudo install -o root -g root -m 600 \
  scripts/deploy/env/ory.env.example /etc/ory-auth/ory.env
sudo install -o root -g root -m 600 \
  scripts/deploy/vps/auth.conf.example /etc/ory-auth/auth.conf
sudo install -o root -g root -m 600 \
  scripts/deploy/vps/admin.conf.example /etc/ory-auth/admin.conf
sudo install -o root -g root -m 600 \
  scripts/deploy/vps/ory.conf.example /etc/ory-auth/ory.conf
```

For production, use the production templates instead:

```sh
sudo install -o root -g root -m 600 \
  scripts/deploy/env/auth-app.production.env.example /etc/ory-auth/auth-app.env
sudo install -o root -g root -m 600 \
  scripts/deploy/env/admin-app.production.env.example /etc/ory-auth/admin-app.env
sudo install -o root -g root -m 600 \
  scripts/deploy/env/ory.production.env.example /etc/ory-auth/ory.env
sudo install -o root -g root -m 600 \
  scripts/deploy/vps/auth.production.conf.example /etc/ory-auth/auth.conf
sudo install -o root -g root -m 600 \
  scripts/deploy/vps/admin.production.conf.example /etc/ory-auth/admin.conf
sudo install -o root -g root -m 600 \
  scripts/deploy/vps/ory.production.conf.example /etc/ory-auth/ory.conf
```

Replace every placeholder using `sudoedit`; never transfer these runtime files
through GitHub Actions:

```sh
sudoedit /etc/ory-auth/auth-app.env
sudoedit /etc/ory-auth/admin-app.env
sudoedit /etc/ory-auth/ory.env
sudoedit /etc/ory-auth/auth.conf
sudoedit /etc/ory-auth/admin.conf
sudoedit /etc/ory-auth/ory.conf

sudo /usr/local/sbin/validate-ory-app-env /etc/ory-auth/auth-app.env
sudo /usr/local/sbin/validate-ory-app-env /etc/ory-auth/admin-app.env
sudo /usr/local/sbin/validate-ory-app-env /etc/ory-auth/ory.env
sudo stat -c '%U:%G %a %n' /etc/ory-auth/*.env /etc/ory-auth/*.conf
```

The default deployment policy requires a root-owned executable backup hook.
Install the organization's tested database/snapshot command and verify it
accepts `COMPONENT GIT_REVISION` arguments:

```sh
sudo install -o root -g root -m 700 \
  /secure/pre-deploy-backup /etc/ory-auth/pre-deploy-backup
sudo test -x /etc/ory-auth/pre-deploy-backup
```

Set `REQUIRE_BACKUP_HOOK=false` only after an explicit risk decision.

## 5. Install the Cloudflare Origin CA certificate

Issue a separate Origin CA certificate per environment with SANs covering its
four exact public hostnames. Install the certificate, private key, and
Cloudflare Origin CA root:

```sh
sudo install -o root -g root -m 644 \
  /secure/origin-cert.pem /etc/ory-auth/tls/origin-cert.pem
sudo install -o root -g ory-auth-tls -m 640 \
  /secure/origin-key.pem /etc/ory-auth/tls/origin-key.pem
sudo install -o root -g root -m 644 \
  /secure/origin-ca.pem /etc/ory-auth/tls/origin-ca.pem

sudo openssl x509 -in /etc/ory-auth/tls/origin-cert.pem -noout \
  -subject -issuer -dates -ext subjectAltName
sudo openssl x509 -in /etc/ory-auth/tls/origin-cert.pem -noout -checkend 2592000
sudo stat -c '%U:%G %a %n' /etc/ory-auth/tls/*
```

Deployments also verify certificate expiry, hostname coverage, and certificate/
private-key matching. Configure independent expiry monitoring.

## 6. Configure Cloudflare and the VPS firewall

For all four environment hostnames:

1. Point proxied DNS records to the correct VPS.
2. Set SSL/TLS mode to **Full (strict)**.
3. Create exact-hostname Origin Rules that overwrite the destination port:
   auth `8444`, admin `8445`, Hydra `8446`, and Kratos `8447`.
4. Restrict origin ports `8444-8447` to Cloudflare's current published IPv4 and
   IPv6 ranges. Keep SSH limited to trusted administrative/CI sources.
5. Do not expose Hydra admin `4445` or Kratos admin `4434` publicly.

After deployment, verify bindings and confirm there is no Nginx listener:

```sh
sudo ss -ltnp
if sudo systemctl is-active --quiet nginx; then
  echo "Nginx is unexpectedly active" >&2
else
  echo "Nginx is not active"
fi
```

## 7. Provision AWS with Terraform

From the workstation repository root:

```sh
cp infrastructure/terraform/aws-development/terraform.tfvars.example \
  infrastructure/terraform/aws-development/terraform.tfvars
${EDITOR:-vi} infrastructure/terraform/aws-development/terraform.tfvars

terraform -chdir=infrastructure/terraform/aws-development init
terraform -chdir=infrastructure/terraform/aws-development fmt -check
terraform -chdir=infrastructure/terraform/aws-development validate
terraform -chdir=infrastructure/terraform/aws-development plan \
  -out=ory-auth-deployment.tfplan
terraform -chdir=infrastructure/terraform/aws-development apply \
  ory-auth-deployment.tfplan
terraform -chdir=infrastructure/terraform/aws-development output \
  github_environment_variables
```

Use an encrypted remote backend for shared state. See
`infrastructure/terraform/aws-development/README.md` for existing-resource
imports, ownership cautions, and decommissioning rules.

## 8. Generate GitHub variables and secrets

Render the five complete non-secret variable files directly from Terraform:

```sh
install -d -m 700 tmp/github-environments
scripts/deploy/render-github-environment-vars.sh \
  infrastructure/terraform/aws-development \
  tmp/github-environments
```

Generate four secret payload files from the protected source material:

```sh
scripts/deploy/prepare-github-environments.sh \
  "${ORY_DEPLOY_INPUTS_ROOT:?}/development/github-deploy-ed25519" \
  "${ORY_DEPLOY_INPUTS_ROOT:?}/development/vps-known-hosts" \
  "${ORY_DEPLOY_INPUTS_ROOT:?}/development/host-release-signing-private.pem" \
  "${ORY_DEPLOY_INPUTS_ROOT:?}/production/github-deploy-ed25519" \
  "${ORY_DEPLOY_INPUTS_ROOT:?}/production/vps-known-hosts" \
  "${ORY_DEPLOY_INPUTS_ROOT:?}/production/host-release-signing-private.pem" \
  tmp/github-environments
```

Inspect file names, modes, and keys without displaying values:

```sh
ls -l tmp/github-environments/*.env
for file in tmp/github-environments/*.env; do
  printf '%s\n' "$file"
  cut -d= -f1 "$file"
done
```

Base64 is transport encoding, not encryption. The generated secret payloads
must remain mode `0600` and must be deleted after successful upload.

## 9. Bulk configure GitHub environments

```sh
scripts/deploy/configure-github-environments.sh \
  tociva/ory-auth-apps \
  tmp/github-environments
```

The uploader creates/updates `ecr-build`, `development-auth`,
`development-admin`, `production-auth`, and `production-admin`. It validates
exact variable/secret contracts and does not print secrets.

Verify the uploaded names:

```sh
for environment in ecr-build development-auth development-admin production-auth production-admin; do
  gh variable list --repo tociva/ory-auth-apps --env "$environment"
done
for environment in development-auth development-admin production-auth production-admin; do
  gh secret list --repo tociva/ory-auth-apps --env "$environment"
done
```

In **Settings → Environments**:

- restrict `ecr-build`, `development-auth`, and `development-admin` to the
  `development` branch;
- restrict both production environments to the `main` branch;
- require reviewers for `production-auth` and `production-admin`;
- prevent administrators from bypassing production approval when supported by
  the repository plan.

After verification, securely remove only the generated payload directory:

```sh
rm -f -- \
  tmp/github-environments/ecr-build.vars.env \
  tmp/github-environments/development-auth.vars.env \
  tmp/github-environments/development-admin.vars.env \
  tmp/github-environments/production-auth.vars.env \
  tmp/github-environments/production-admin.vars.env \
  tmp/github-environments/development-auth.secrets.env \
  tmp/github-environments/development-admin.secrets.env \
  tmp/github-environments/production-auth.secrets.env \
  tmp/github-environments/production-admin.secrets.env
rmdir tmp/github-environments
```

These generated copies are not recoverable after removal. Retain the protected
source keys and Terraform state in their approved stores.

## 10. Deploy development, then promote production

Run auth first because it also deploys Hydra/Kratos configuration, then admin:

```sh
gh workflow run deploy-auth-development.yml \
  --repo tociva/ory-auth-apps --ref development
gh run watch --repo tociva/ory-auth-apps --exit-status

gh workflow run deploy-admin-development.yml \
  --repo tociva/ory-auth-apps --ref development
gh run watch --repo tociva/ory-auth-apps --exit-status
```

Verify through Cloudflare:

```sh
curl --fail --show-error --silent https://auth-dev.idnest.cloud/health
curl --fail --show-error --silent https://admin-dev.idnest.cloud/health
curl --fail --show-error --silent https://hydra-dev.idnest.cloud/health/ready
curl --fail --show-error --silent https://kratos-dev.idnest.cloud/health/ready
```

Production promotion requires the full Git revision and exact `sha256:...`
digest recorded by the successful development workflow:

```sh
gh workflow run deploy-production.yml \
  --repo tociva/ory-auth-apps \
  --ref main \
  -f component=auth \
  -f revision=FULL_40_CHARACTER_GIT_SHA \
  -f image_digest=sha256:TESTED_AUTH_IMAGE_DIGEST

gh workflow run deploy-production.yml \
  --repo tociva/ory-auth-apps \
  --ref main \
  -f component=admin \
  -f revision=FULL_40_CHARACTER_GIT_SHA \
  -f image_digest=sha256:TESTED_ADMIN_IMAGE_DIGEST
```

Approve each protected production environment only after reviewing the digest,
revision, development result, database backup, and Cloudflare origin rules.

## 11. Rollback and diagnostics

Rollback recreates the previous digest on the same fixed HTTPS port. It does not
reverse database migrations:

```sh
sudo /usr/local/sbin/rollback-ory-auth
sudo /usr/local/sbin/rollback-ory-admin
```

Inspect queue and container state:

```sh
sudo systemctl status ory-auth-release-queue.path --no-pager
sudo journalctl -u ory-auth-release-queue.service -n 200 --no-pager
sudo docker compose -f /opt/ory-auth/auth/compose.yaml ps
sudo docker compose -f /opt/ory-auth/admin/compose.yaml ps
sudo docker compose -f /opt/ory-auth/ory/compose.yaml ps
sudo find /var/lib/ory-auth/queue/results -maxdepth 1 -type f -ls
```

The fixed port creates a short interruption during container recreation. Failed
candidates restore the previously retained digest. Database changes must follow
expand/contract migration rules.
