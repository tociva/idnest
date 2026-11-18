#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Delivery contract failed: $*" >&2
  exit 1
}

require_text() {
  local file=$1 text=$2
  grep -Fq -- "$text" "$file" || fail "$file is missing: $text"
}

reject_pattern() {
  local pattern=$1
  shift
  if grep -R -n -E --exclude=test-deployment-contracts.sh -- "$pattern" "$@"; then
    fail "retired delivery setting matched: $pattern"
  fi
}

bash deploy/ci/test-image-release-contracts.sh
bash deploy/images/test-builder-contract.sh
bash deploy/ci/test-apple-login-contracts.sh

while IFS= read -r script; do
  case "$script" in
    *.bash) bash -n "$script" ;;
    *)
      if head -n 1 "$script" | grep -q 'bash'; then bash -n "$script"; else sh -n "$script"; fi
      ;;
  esac
done < <(find deploy/ci deploy/images deploy/tools deploy/vps -type f -name '*.sh' -print | sort)

if command -v shellcheck >/dev/null 2>&1; then
  mapfile -t shell_scripts < <(find deploy/ci deploy/images deploy/tools deploy/vps -type f -name '*.sh' -print | sort)
  shellcheck -x "${shell_scripts[@]}"
fi

mapfile -t workflows < <(find .github/workflows -maxdepth 1 -type f -name '*.yml' -print | sort)
[[ ${#workflows[@]} -eq 2 ]] || fail "exactly two build workflows must remain"
[[ ${workflows[0]} == .github/workflows/build-application-image.yml ]]
[[ ${workflows[1]} == .github/workflows/build-builder-base.yml ]]

require_text .github/workflows/build-application-image.yml 'options: [auth, admin, all]'
require_text .github/workflows/build-application-image.yml 'options: [patch, minor, major]'
require_text .github/workflows/build-application-image.yml 'deploy/ci/promote-ecr-public-image.sh'
require_text .github/workflows/build-application-image.yml 'aquasecurity/trivy-action@'
require_text .github/workflows/build-application-image.yml 'version: v0.76.2'
require_text .github/workflows/build-application-image.yml 'ignore-unfixed: true'
require_text .github/workflows/build-application-image.yml 'contents: write'
require_text .github/workflows/build-application-image.yml 'deploy/ci/release-version.mjs'
# The workflow expression must remain literal for this contract assertion.
# shellcheck disable=SC2016
require_text .github/workflows/build-application-image.yml 'git push origin "HEAD:${GITHUB_REF_NAME}"'
reject_pattern 'setup-helm|kubectl|helm upgrade|AWS_DEPLOY_ROLE_ARN|VPS_SSH' .github/workflows
reject_pattern 'inputs\.version|^[[:space:]]+version:[[:space:]]*$' \
  .github/workflows/build-application-image.yml
reject_pattern 'refs/heads/development|Require the development branch|branches:[[:space:]]*$' \
  .github/workflows/build-application-image.yml \
  .github/workflows/build-builder-base.yml
reject_pattern '^[[:space:]]+push:[[:space:]]*$' .github/workflows/build-builder-base.yml
require_text .github/workflows/build-builder-base.yml 'workflow_dispatch:'

require_text deploy/vps/deploy-idnest-version.sh \
  'usage: deploy-idnest-version VERSION [auth|admin|all]'
require_text deploy/vps/deploy-idnest-version.sh \
  'Rollback uses the same command with an older published version.'
# The deployment-script variable must remain literal for this contract assertion.
# shellcheck disable=SC2016
require_text deploy/vps/deploy-idnest-version.sh 'docker pull "$tag_ref"'
require_text deploy/vps/deploy-idnest-version.sh 'node migrations/authz-migrate.cjs'
require_text deploy/vps/deploy-idnest-version.sh 'node scripts/setup/provision-admin-client.js'
require_text deploy/vps/bootstrap-idnest-host.sh '/usr/local/sbin/deploy-idnest-version'

# Compose variables must remain literal for these contract assertions.
# shellcheck disable=SC2016
require_text deploy/vps/compose.auth.yaml '127.0.0.1:${AUTH_HTTP_PORT:-8444}:3000'
# shellcheck disable=SC2016
require_text deploy/vps/compose.admin.yaml '127.0.0.1:${ADMIN_HTTP_PORT:-8445}:3000'
# shellcheck disable=SC2016
require_text deploy/vps/compose.idnest.yaml '127.0.0.1:${HYDRA_PUBLIC_HTTP_PORT:-8446}:4444'
# shellcheck disable=SC2016
require_text deploy/vps/compose.idnest.yaml '127.0.0.1:${KRATOS_ADMIN_HTTP_PORT:-4434}:4434'
reject_pattern '0\.0\.0\.0:\$\{[^}]*PORT' deploy/vps/compose.*.yaml
require_text deploy/vps/README.md '| auth-dev | idnest.cloud | http://127.0.0.1:8444 |'
require_text deploy/vps/README.md '| admin-dev | idnest.cloud | http://127.0.0.1:8445 |'
require_text deploy/vps/README.md '| hydra-dev | idnest.cloud | http://127.0.0.1:8446 |'
require_text deploy/vps/README.md '| kratos-dev | idnest.cloud | http://127.0.0.1:8447 |'

require_text deploy/tools/sync-ecr-build-github.sh 'ENVIRONMENT=ecr-build'
reject_pattern 'development-auth|development-admin|development-identity|AWS_DEPLOY_ROLE_ARN|VPS_HOST|VPS_PORT|VPS_USER' \
  deploy/terraform/aws-development/*.tf \
  deploy/terraform/aws-development/terraform.tfvars.example \
  deploy/tools/sync-ecr-build-github.sh \
  deploy/env/development.env.example
reject_pattern 'aws_region|retain_legacy_private_ecr|force_delete_ecr|aws_ecr_repository|aws_ecr_lifecycle_policy|aws\.ecr_public' \
  deploy/terraform/aws-development/*.tf \
  deploy/terraform/aws-development/terraform.tfvars.example
reject_pattern 'dkr\.ecr\.|aws ecr describe-images|ecr_service' \
  deploy/images/ensure-builder-image.sh .github/workflows
require_text deploy/images/ensure-builder-image.sh 'aws ecr-public describe-images'

reject_pattern 'release.queue|release-queue|KUBECONFIG|deploy/charts|helm' \
  .github deploy/ci deploy/tools deploy/vps deploy/README.md package.json
reject_pattern 'APPLE_PRIVATE_KEY_B64' \
  deploy/tools/create-development-env.sh \
  deploy/tools/render-development-identity-env.sh \
  deploy/vps/validate-app-env.sh \
  deploy/env config .github

temporary=$(mktemp -d "${TMPDIR:-/tmp}/idnest-delivery-contract.XXXXXX")
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT HUP INT TERM

release_manifest=$temporary/package.json
for release_case in patch:1.2.4 minor:1.3.0 major:2.0.0; do
  release_type=${release_case%%:*}
  expected_version=${release_case#*:}
  printf '%s\n' '{"name":"release-contract","version":"1.2.3"}' >"$release_manifest"
  actual_version=$(node deploy/ci/release-version.mjs "$release_type" \
    --write --package "$release_manifest")
  [[ "$actual_version" == "$expected_version" ]] \
    || fail "$release_type calculated $actual_version instead of $expected_version"
  [[ $(node -p "require(process.argv[1]).version" "$release_manifest") == "$expected_version" ]] \
    || fail "$release_type did not persist $expected_version"
done

generated=$temporary/development.env
bash deploy/tools/create-development-env.sh "$generated" >/dev/null
generated_keys=$(awk -F= 'NF >= 2 { print $1 }' "$generated" | sort | tr '\n' ' ')
example_keys=$(awk -F= 'NF >= 2 { print $1 }' deploy/env/development.env.example | sort | tr '\n' ' ')
[[ "$generated_keys" == "$example_keys" ]] || fail "runtime environment generator drifted from its example"
reject_pattern '^AWS_|^VPS_' "$generated"

fake_bin=$temporary/fake-bin
fake_terraform_directory=$temporary/terraform
mkdir -p "$fake_bin" "$fake_terraform_directory"
cat >"$fake_bin/terraform" <<'EOF'
#!/bin/sh
case "$*" in
  *" output -raw ecr_public_registry")
    printf '%s\n' 'public.ecr.aws/contract-alias'
    ;;
  *" output -json ecr_repositories")
    printf '%s\n' '{"auth":"idnest/contract-auth","admin":"idnest/contract-admin"}'
    ;;
  *)
    echo "Unexpected fake Terraform arguments: $*" >&2
    exit 1
    ;;
esac
EOF
chmod 755 "$fake_bin/terraform"

synced_development_env=$temporary/synced-development.env
printf '%s\n' \
  'ECR_PUBLIC_REGISTRY=public.ecr.aws/stale' \
  'AUTH_ECR_REPOSITORY=idnest/stale-auth' \
  'ADMIN_ECR_REPOSITORY=idnest/stale-admin' \
  'SKIP_PUBLIC_HEALTH_CHECK=true' \
  'PRESERVED_SECRET=contract-secret' >"$synced_development_env"
PATH="$fake_bin:$PATH" deploy/tools/sync-development-ecr-values.sh \
  "$fake_terraform_directory" "$synced_development_env" >/dev/null
require_text "$synced_development_env" 'ECR_PUBLIC_REGISTRY=public.ecr.aws/contract-alias'
require_text "$synced_development_env" 'AUTH_ECR_REPOSITORY=idnest/contract-auth'
require_text "$synced_development_env" 'ADMIN_ECR_REPOSITORY=idnest/contract-admin'
require_text "$synced_development_env" 'SKIP_PUBLIC_HEALTH_CHECK=true'
require_text "$synced_development_env" 'PRESERVED_SECRET=contract-secret'
[[ $(stat -f '%Lp' "$synced_development_env" 2>/dev/null || stat -c '%a' "$synced_development_env") == 600 ]] \
  || fail "Terraform ECR sync did not protect development.env"

ECR_PUBLIC_REGISTRY='public.ecr.aws/example-alias' \
AUTH_ECR_REPOSITORY='idnest/auth-app' \
ADMIN_ECR_REPOSITORY='idnest/admin-app' \
SKIP_PUBLIC_HEALTH_CHECK='false' \
  deploy/tools/render-development-deploy-conf.sh "$temporary/deploy.conf" >/dev/null
require_text "$temporary/deploy.conf" 'ECR_PUBLIC_REGISTRY=public.ecr.aws/example-alias'
require_text "$temporary/deploy.conf" 'AUTH_ECR_REPOSITORY=idnest/auth-app'
require_text "$temporary/deploy.conf" 'ADMIN_ECR_REPOSITORY=idnest/admin-app'
require_text "$temporary/deploy.conf" 'SKIP_PUBLIC_HEALTH_CHECK=false'
[[ $(stat -f '%Lp' "$temporary/deploy.conf" 2>/dev/null || stat -c '%a' "$temporary/deploy.conf") == 600 ]] \
  || fail "rendered deployment configuration does not have mode 600"
if ECR_PUBLIC_REGISTRY='private.invalid/example' \
  AUTH_ECR_REPOSITORY='idnest/auth-app' \
  ADMIN_ECR_REPOSITORY='idnest/admin-app' \
  SKIP_PUBLIC_HEALTH_CHECK='false' \
    deploy/tools/render-development-deploy-conf.sh "$temporary/invalid-deploy.conf" >/dev/null 2>&1; then
  fail "deployment configuration renderer accepted a non-ECR-Public registry"
fi

HYDRA_DSN='postgres://hydra:test@db.invalid:5432/hydra?sslmode=disable' \
HYDRA_SECRETS_SYSTEM='0123456789abcdef0123456789abcdef' \
KRATOS_DSN='postgres://kratos:test@db.invalid:5432/kratos?sslmode=disable' \
KRATOS_CSRF_COOKIE_SECRET='0123456789abcdef0123456789abcdef' \
KRATOS_CIPHER_SECRET='0123456789abcdef0123456789abcdef' \
GOOGLE_CLIENT_ID='delivery-contract' \
GOOGLE_CLIENT_SECRET='delivery-contract-secret' \
  deploy/tools/render-development-identity-env.sh "$temporary/idnest.env" >/dev/null

AUTHZ_DATABASE_URL='postgres://authz:test@db.invalid:5432/authz?sslmode=disable' \
CONSENT_ACTION_SECRET='0123456789abcdef0123456789abcdef' \
AUTH_TRANSACTION_SECRET='0123456789abcdef0123456789abcdef' \
AUTH_AUDIT_HASH_SECRET='0123456789abcdef0123456789abcdef' \
DELEGATION_SIGNING_PRIVATE_KEY_B64='dGVzdA==' \
ADMIN_BOOTSTRAP_EMAILS='delivery-contract@idnest.cloud' \
  deploy/tools/render-development-app-env.sh auth "$temporary/auth.env" >/dev/null

AUTHZ_DATABASE_URL='postgres://authz:test@db.invalid:5432/authz?sslmode=disable' \
ADMIN_CSRF_SECRET='0123456789abcdef0123456789abcdef' \
ADMIN_OIDC_CLIENT_SECRET='0123456789abcdef0123456789abcdef' \
ADMIN_BOOTSTRAP_EMAILS='delivery-contract@idnest.cloud' \
  deploy/tools/render-development-app-env.sh admin "$temporary/admin.env" >/dev/null

digest=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
APP_IMAGE="public.ecr.aws/idnest/idnest/auth-app@sha256:$digest" \
APP_ENV_FILE="$temporary/auth.env" RUNTIME_NETWORK=idnest-runtime-development AUTH_HTTP_PORT=8444 \
  docker compose --file deploy/vps/compose.auth.yaml config --quiet
APP_IMAGE="public.ecr.aws/idnest/idnest/admin-app@sha256:$digest" \
APP_ENV_FILE="$temporary/admin.env" RUNTIME_NETWORK=idnest-runtime-development ADMIN_HTTP_PORT=8445 \
  docker compose --file deploy/vps/compose.admin.yaml config --quiet
IDNEST_ENV_FILE="$temporary/idnest.env" IDNEST_RUNTIME_NETWORK=idnest-runtime-development \
  docker compose --file deploy/vps/compose.idnest.yaml config --quiet

echo "Build-only and direct VPS delivery contracts passed."
