# Build and VPS operations

## 1. Provision build infrastructure

Authenticate AWS, copy the Terraform variable example, review the plan, and
apply it as described in [terraform/aws-development/README.md](terraform/aws-development/README.md).
Then update only the `ecr-build` GitHub Environment:

```bash
./deploy/tools/sync-ecr-build-github.sh
```

The sync script never changes deployment environments or secrets.

## 2. Publish images

```bash
gh workflow run build-application-image.yml \
  --repo tociva/idnest \
  --ref BRANCH_NAME \
  -f component=all \
  -f release=patch
```

The selected branch must contain the current workflow and delivery scripts.
Choose `patch`, `minor`, or `major`; the workflow derives the next version from
the selected branch's root `package.json` and commits it after the selected
images pass. The separate builder workflow is manual-only. Application builds
still create the required builder image automatically when it is missing.

## 3. Prepare runtime values

Create or reconcile the protected runtime source on a trusted workstation:

```bash
./deploy/tools/create-development-env.sh
```

`tmp/development.env` contains application, identity, database, and provider
values only. AWS roles, repositories, and VPS SSH coordinates are deliberately
not part of it. To import or replace the Apple PKCS#8 `.p8` private key without
printing it, run:

```bash
./deploy/tools/update-development-apple-key.sh \
  /secure/path/AuthKey_KEYID.p8
```

The helper validates the key, stores `APPLE_PRIVATE_KEY` as a safe single-line
value, and atomically protects `tmp/development.env` with mode `0600`. Replace
the remaining provider/admin placeholders, validate the source, and render the
three files required by the host:

```bash
./deploy/vps/validate-app-env.sh tmp/development.env development-source

set -a
source tmp/development.env
set +a
./deploy/tools/render-development-identity-env.sh tmp/idnest.env
./deploy/tools/render-development-app-env.sh auth tmp/auth-app.env
./deploy/tools/render-development-app-env.sh admin tmp/admin-app.env
```

Treat all four files as secrets. Do not commit or print them.

## 4. Bootstrap the VPS

For a fresh Ubuntu ARM64 host, follow the complete SSH, Docker installation,
file upload, deployment, verification, and reboot-persistence runbook in
[vps/README.md](vps/README.md).

In summary, upload the repository's `deploy/` and `config/` directories to the
VPS. Docker Engine with the Compose plugin must already be installed. From the
uploaded repository root run:

```bash
sudo ./deploy/vps/bootstrap-idnest-host.sh
```

Review `/etc/idnest/*.conf`, set the public registry alias in
`/etc/idnest/deploy.conf`, and install the rendered files:

```text
/etc/idnest/idnest.env
/etc/idnest/auth-app.env
/etc/idnest/admin-app.env
```

They must be owned by root with mode `0600`. Configure PostgreSQL and the
Cloudflare Tunnel before the first deployment. The three DSNs must be reachable
from containers through the configured runtime network.

## 5. Deploy or roll back

```bash
sudo deploy-idnest-version 1.4.0 all
sudo deploy-idnest-version 1.3.0 all  # rollback
```

Use `auth` or `admin` instead of `all` for a component-only release. A failed
application readiness check restores the previously active application image.
Identity and database migrations are forward-only.

## 6. Validate repository contracts

```bash
pnpm test:deploy
terraform -chdir=deploy/terraform/aws-development validate
```
