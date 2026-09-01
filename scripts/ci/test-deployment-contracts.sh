#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Deployment contract test failed: $*" >&2
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

for command in awk bash docker grep mktemp openssl rg rm sh sort; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

while IFS= read -r script; do
  case "$(head -n 1 "$script")" in
    *bash*) bash -n "$script" ;;
    *) sh -n "$script" ;;
  esac
done < <(find scripts -type f -name '*.sh' -print | sort)

bash scripts/ci/test-apple-login-contracts.sh

if command -v shellcheck >/dev/null 2>&1; then
  mapfile -t shell_scripts < <(find scripts/deploy/ci scripts/deploy/vps scripts/ci -type f -name '*.sh' -print | sort)
  shellcheck -x "${shell_scripts[@]}"
fi

require_text() {
  local file=$1 text=$2
  grep -Fq -- "$text" "$file" || fail "$file is missing: $text"
}

reject_pattern() {
  local pattern=$1
  shift
  if rg -n -S "$pattern" "$@"; then
    fail "retired or unsafe deployment setting matched: $pattern"
  fi
}

require_text scripts/deploy/vps/compose.auth.yaml \
  "127.0.0.1:\${AUTH_HTTP_PORT:-8444}:3000"
require_text scripts/deploy/vps/compose.admin.yaml \
  "127.0.0.1:\${ADMIN_HTTP_PORT:-8445}:3000"
require_text scripts/deploy/vps/compose.idnest.yaml \
  "127.0.0.1:\${HYDRA_PUBLIC_HTTP_PORT:-8446}:4444"
require_text scripts/deploy/vps/compose.idnest.yaml \
  "127.0.0.1:\${HYDRA_ADMIN_HTTP_PORT:-4445}:4445"
require_text scripts/deploy/vps/compose.idnest.yaml \
  "127.0.0.1:\${KRATOS_PUBLIC_HTTP_PORT:-8447}:4433"
require_text scripts/deploy/vps/compose.idnest.yaml \
  "127.0.0.1:\${KRATOS_ADMIN_HTTP_PORT:-4434}:4434"

reject_pattern "0\\.0\\.0\\.0:\\$\\{[^}]*PORT" scripts/deploy/vps/compose.*.yaml
reject_pattern "TLS_CERT|TLS_KEY|TLS_SERVER|HTTPS_ENABLED|ORIGIN_HTTPS|SERVE_TLS" \
  scripts/deploy/vps scripts/docker/Dockerfile.auth-app \
  scripts/docker/Dockerfile.admin-app config/kratos.tpl.yml
reject_pattern "origin-ca|origin-cert|Origin CA|Origin Rules" README.md scripts/deploy

require_text scripts/deploy/vps/idnest-cloudflared.service \
  'LoadCredential=tunnel-token:/etc/idnest/cloudflared.token'
require_text scripts/deploy/vps/idnest-cloudflared.service \
  '--metrics 127.0.0.1:20242'
require_text scripts/deploy/vps/idnest-cloudflared.service \
  '--token-file ${CREDENTIALS_DIRECTORY}/tunnel-token'
require_text scripts/deploy/vps/validate-development-host.sh \
  'http://127.0.0.1:20242/ready'
require_text scripts/deploy/vps/bootstrap-development-vps.sh \
  '/etc/idnest/cloudflared.token'
require_text scripts/deploy/transfer-development-vps-bootstrap.sh \
  'cloudflared.token'
require_text scripts/deploy/vps/provision-host.sh \
  'idnest-cloudflared.service'
require_text scripts/deploy/vps/activate-host-release.sh \
  'scripts/deploy/vps/idnest-cloudflared.service'
require_text scripts/deploy/manifests/host-release-files.txt \
  'scripts/deploy/vps/idnest-cloudflared.service'
require_text scripts/deploy/ci/release-common.sh \
  'scripts/deploy/manifests/host-release-files.txt'

expected_host_release_files='scripts/deploy/vps/Dockerfile.kratos
scripts/deploy/vps/compose.admin.yaml
scripts/deploy/vps/compose.auth.yaml
scripts/deploy/vps/compose.idnest.yaml
scripts/deploy/vps/deploy-idnest-admin.sh
scripts/deploy/vps/deploy-idnest-app.sh
scripts/deploy/vps/deploy-idnest-auth.sh
scripts/deploy/vps/deploy-idnest-infra.sh
scripts/deploy/vps/idnest-cloudflared.service
scripts/deploy/vps/rollback-idnest-admin.sh
scripts/deploy/vps/rollback-idnest-app.sh
scripts/deploy/vps/rollback-idnest-auth.sh
scripts/deploy/vps/validate-app-env.sh
scripts/docker/render-kratos-config.sh'
actual_host_release_files=$(grep -Ev '^(#|$)' scripts/deploy/manifests/host-release-files.txt | sort)
[ "$actual_host_release_files" = "$expected_host_release_files" ] \
  || fail "host release manifest drifted from the VPS activation contract"

for workflow in \
  .github/workflows/deploy-auth-development.yml \
  .github/workflows/deploy-admin-development.yml \
  .github/workflows/deploy-identity-development.yml \
  .github/workflows/rollback-development.yml \
  .github/workflows/deploy-production.yml; do
  require_text "$workflow" 'scripts/deploy/ci/prepare-release-request.sh'
  require_text "$workflow" 'scripts/deploy/ci/upload-release-request.sh'
  require_text "$workflow" 'scripts/deploy/ci/submit-release-request.sh'
  require_text "$workflow" 'scripts/deploy/ci/cleanup-release-request.sh'
done
reject_pattern 'scp_args=|ssh_args=|base64 --decode|aws ecr get-login-password|submit-idnest-release|wait-idnest-release|tar --create --gzip --file "\$\{RUNNER_TEMP\}/host-release\.tar\.gz"' \
  .github/workflows/deploy-auth-development.yml \
  .github/workflows/deploy-admin-development.yml \
  .github/workflows/deploy-identity-development.yml \
  .github/workflows/rollback-development.yml \
  .github/workflows/deploy-production.yml

if rg -n 'CLOUDFLARE_TUNNEL_TOKEN|cloudflared\.token' .github/workflows; then
  fail "the tunnel credential must not be available to GitHub Actions"
fi

require_text scripts/deploy/render-development-app-env.sh \
  'HYDRA_ADMIN_URL=http://idnest-hydra:4445'
require_text scripts/deploy/render-development-app-env.sh \
  'KRATOS_INTERNAL_URL=http://idnest-kratos:4433'
require_text scripts/deploy/render-development-app-env.sh \
  'ADMIN_OIDC_TOKEN_URL=http://idnest-hydra:4444/oauth2/token'
require_text scripts/deploy/README.md \
  './scripts/deploy/create-development-env.sh'

temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/idnest-deployment-contract.XXXXXX")
cleanup() {
  rm -rf -- "$temporary_directory"
}
trap cleanup EXIT INT TERM

generated_development_env="$temporary_directory/development.env"
bash scripts/deploy/create-development-env.sh \
  "$generated_development_env" \
  "$temporary_directory/missing-terraform" >/dev/null
[ -f "$generated_development_env" ] || fail "development environment generator did not create a file"
[ "$(awk -F= 'NF >= 2 { print $1 }' "$generated_development_env" | sort | uniq -d)" = "" ] \
  || fail "development environment generator wrote duplicate keys"
generated_keys=$(awk -F= 'NF >= 2 { print $1 }' "$generated_development_env" | sort | tr '\n' ' ')
expected_generated_keys=$(awk -F= 'NF >= 2 { print $1 }' scripts/deploy/env/development.env.example | sort | tr '\n' ' ')
[ "$generated_keys" = "$expected_generated_keys" ] \
  || fail "development environment generator keys drifted from development.env.example"
for generated_key in \
  HYDRA_DSN KRATOS_DSN AUTHZ_DATABASE_URL HYDRA_SECRETS_SYSTEM \
  KRATOS_CSRF_COOKIE_SECRET KRATOS_CIPHER_SECRET CONSENT_ACTION_SECRET \
  AUTH_TRANSACTION_SECRET AUTH_AUDIT_HASH_SECRET ADMIN_CSRF_SECRET \
  ADMIN_OIDC_CLIENT_SECRET DELEGATION_SIGNING_PRIVATE_KEY_B64; do
  generated_value=$(awk -F= -v key="$generated_key" '$1 == key { print substr($0, index($0, "=") + 1) }' "$generated_development_env")
  [ -n "$generated_value" ] || fail "development environment generator missed $generated_key"
  case "$generated_value" in
    *replace-with-*) fail "development environment generator did not generate $generated_key" ;;
  esac
done
generated_cipher_secret=$(awk -F= '$1 == "KRATOS_CIPHER_SECRET" { print $2 }' "$generated_development_env")
[ "${#generated_cipher_secret}" -eq 32 ] \
  || fail "development environment generator wrote invalid KRATOS_CIPHER_SECRET length"
generated_placeholder_keys=$(awk -F= '$2 ~ /^replace-with-/ { print $1 }' "$generated_development_env" | sort | tr '\n' ' ')
expected_placeholder_keys="ADMIN_AWS_DEPLOY_ROLE_ARN ADMIN_BOOTSTRAP_EMAILS ADMIN_ECR_REPOSITORY AUTH_AWS_DEPLOY_ROLE_ARN AUTH_ECR_REPOSITORY AWS_ACCOUNT_ID AWS_BUILD_ROLE_ARN AWS_REGION BUILDER_ECR_REPOSITORY CLOUDFLARE_TUNNEL_TOKEN GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET VPS_HOST VPS_PORT VPS_USER "
[ "$generated_placeholder_keys" = "$expected_placeholder_keys" ] \
  || fail "development environment generator wrote unexpected replace-with placeholders"
printf '%s' "$(awk -F= '$1 == "DELEGATION_SIGNING_PRIVATE_KEY_B64" { print $2 }' "$generated_development_env")" \
  | openssl base64 -d -A \
  | openssl pkey -text -noout 2>/dev/null \
  | grep -Eq 'ASN1 OID: prime256v1|NIST CURVE: P-256' \
  || fail "development environment generator wrote an invalid delegation key"

HYDRA_DSN='postgres://hydra:test@db.invalid:5432/hydra?sslmode=disable' \
HYDRA_SECRETS_SYSTEM='0123456789abcdef0123456789abcdef' \
KRATOS_DSN='postgres://kratos:test@db.invalid:5432/kratos?sslmode=disable' \
KRATOS_CSRF_COOKIE_SECRET='0123456789abcdef0123456789abcdef' \
KRATOS_CIPHER_SECRET='0123456789abcdef0123456789abcdef' \
GOOGLE_CLIENT_ID='deployment-contract' \
GOOGLE_CLIENT_SECRET='deployment-contract-secret' \
  scripts/deploy/render-development-identity-env.sh \
  "$temporary_directory/idnest.env" >/dev/null

AUTHZ_DATABASE_URL='postgres://authz:test@db.invalid:5432/authz?sslmode=disable' \
CONSENT_ACTION_SECRET='0123456789abcdef0123456789abcdef' \
AUTH_TRANSACTION_SECRET='0123456789abcdef0123456789abcdef' \
AUTH_AUDIT_HASH_SECRET='0123456789abcdef0123456789abcdef' \
DELEGATION_ENABLED=false \
DELEGATION_SIGNING_PRIVATE_KEY_B64='dGVzdA==' \
ADMIN_BOOTSTRAP_EMAILS='deployment-contract@idnest.cloud' \
  scripts/deploy/render-development-app-env.sh auth \
  "$temporary_directory/auth.env" >/dev/null

AUTHZ_DATABASE_URL='postgres://authz:test@db.invalid:5432/authz?sslmode=disable' \
ADMIN_CSRF_SECRET='0123456789abcdef0123456789abcdef' \
ADMIN_OIDC_CLIENT_SECRET='0123456789abcdef0123456789abcdef' \
ADMIN_BOOTSTRAP_EMAILS='deployment-contract@idnest.cloud' \
  scripts/deploy/render-development-app-env.sh admin \
  "$temporary_directory/admin.env" >/dev/null

image_digest=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
APP_IMAGE="example.invalid/idnest/auth@sha256:$image_digest" \
APP_ENV_FILE="$temporary_directory/auth.env" \
RUNTIME_NETWORK=idnest-runtime-development \
AUTH_HTTP_PORT=8444 \
  docker compose --file scripts/deploy/vps/compose.auth.yaml config --quiet
APP_IMAGE="example.invalid/idnest/admin@sha256:$image_digest" \
APP_ENV_FILE="$temporary_directory/admin.env" \
RUNTIME_NETWORK=idnest-runtime-development \
ADMIN_HTTP_PORT=8445 \
  docker compose --file scripts/deploy/vps/compose.admin.yaml config --quiet
IDNEST_ENV_FILE="$temporary_directory/idnest.env" \
IDNEST_RUNTIME_NETWORK=idnest-runtime-development \
  docker compose --file scripts/deploy/vps/compose.idnest.yaml config --quiet

echo "Cloudflare Tunnel deployment contracts passed."
