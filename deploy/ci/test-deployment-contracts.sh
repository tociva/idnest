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
[[ ${workflows[1]} == .github/workflows/build-builder-base-development.yml ]]

require_text .github/workflows/build-application-image.yml 'options: [auth, admin, all]'
require_text .github/workflows/build-application-image.yml 'deploy/ci/promote-ecr-public-image.sh'
require_text .github/workflows/build-application-image.yml 'aquasecurity/trivy-action@'
reject_pattern 'setup-helm|kubectl|helm upgrade|AWS_DEPLOY_ROLE_ARN|VPS_SSH' .github/workflows

require_text deploy/vps/deploy-idnest-version.sh \
  'usage: deploy-idnest-version VERSION [auth|admin|all]'
require_text deploy/vps/deploy-idnest-version.sh \
  'Rollback uses the same command with an older published version.'
require_text deploy/vps/deploy-idnest-version.sh 'docker pull "$tag_ref"'
require_text deploy/vps/deploy-idnest-version.sh 'node migrations/authz-migrate.cjs'
require_text deploy/vps/deploy-idnest-version.sh 'node scripts/setup/provision-admin-client.js'
require_text deploy/vps/bootstrap-idnest-host.sh '/usr/local/sbin/deploy-idnest-version'

require_text deploy/vps/compose.auth.yaml '127.0.0.1:${AUTH_HTTP_PORT:-8444}:3000'
require_text deploy/vps/compose.admin.yaml '127.0.0.1:${ADMIN_HTTP_PORT:-8445}:3000'
require_text deploy/vps/compose.idnest.yaml '127.0.0.1:${HYDRA_PUBLIC_HTTP_PORT:-8446}:4444'
require_text deploy/vps/compose.idnest.yaml '127.0.0.1:${KRATOS_ADMIN_HTTP_PORT:-4434}:4434'
reject_pattern '0\.0\.0\.0:\$\{[^}]*PORT' deploy/vps/compose.*.yaml

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

temporary=$(mktemp -d "${TMPDIR:-/tmp}/idnest-delivery-contract.XXXXXX")
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT HUP INT TERM

generated=$temporary/development.env
bash deploy/tools/create-development-env.sh "$generated" >/dev/null
generated_keys=$(awk -F= 'NF >= 2 { print $1 }' "$generated" | sort | tr '\n' ' ')
example_keys=$(awk -F= 'NF >= 2 { print $1 }' deploy/env/development.env.example | sort | tr '\n' ' ')
[[ "$generated_keys" == "$example_keys" ]] || fail "runtime environment generator drifted from its example"
reject_pattern '^AWS_|^ECR_|^VPS_' "$generated"

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
