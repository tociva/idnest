#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

fail() {
  echo "CORS configuration contract test failed: $*" >&2
  exit 1
}

require_line() {
  local file="$1" line="$2"
  grep -Fqx -- "$line" "$file" \
    || fail "$file is missing: $line"
}

require_text() {
  local file="$1" text="$2"
  grep -Fq -- "$text" "$file" \
    || fail "$file is missing the expected CORS setting: $text"
}

reject_legacy_key() {
  local file="$1"
  if grep -Eq '^[[:space:]]*(export[[:space:]]+)?CORS_ALLOWED_ORIGINS=' "$file"; then
    fail "$file still defines the retired shared CORS_ALLOWED_ORIGINS key"
  fi
}

for command in grep mktemp openssl rm sed; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

require_line "$REPO_ROOT/.env.example" \
  'HYDRA_CORS_ALLOWED_ORIGINS=https://hydra-local.idnest.cloud'
require_line "$REPO_ROOT/.env.example" \
  'KRATOS_CORS_ALLOWED_ORIGINS=https://auth-local.idnest.cloud'
require_line "$REPO_ROOT/.env.example" \
  "KRATOS_TOTP_ISSUER='Idnest Local'"
require_line "$REPO_ROOT/monorepo/.env.example" \
  'AUTH_RETURN_TO_ALLOWED_ORIGINS=https://admin-local.idnest.cloud'
require_line "$SCRIPT_DIR/env/development.env.example" \
  'HYDRA_CORS_ALLOWED_ORIGINS=https://hydra-dev.idnest.cloud'
require_line "$SCRIPT_DIR/env/development.env.example" \
  'KRATOS_CORS_ALLOWED_ORIGINS=https://auth-dev.idnest.cloud'
require_line "$SCRIPT_DIR/env/development.env.example" \
  "KRATOS_TOTP_ISSUER='Idnest Development'"

for file in \
  "$REPO_ROOT/.env.example" \
  "$REPO_ROOT/monorepo/.env.example" \
  "$SCRIPT_DIR/env/development.env.example" \
  "$SCRIPT_DIR/render-development-app-env.sh" \
  "$SCRIPT_DIR/render-development-identity-env.sh" \
  "$SCRIPT_DIR/vps/validate-app-env.sh"; do
  reject_legacy_key "$file"
done

for file in \
  "$REPO_ROOT/scripts/docker/docker-compose.yml" \
  "$SCRIPT_DIR/vps/compose.idnest.yaml"; do
  require_text "$file" \
    'HYDRA_CORS_ALLOWED_ORIGINS:?HYDRA_CORS_ALLOWED_ORIGINS is required'
done

require_text "$REPO_ROOT/scripts/docker/render-kratos-config.sh" \
  'KRATOS_CORS_ALLOWED_ORIGINS:?KRATOS_CORS_ALLOWED_ORIGINS is required'
require_text "$REPO_ROOT/scripts/docker/render-kratos-config.sh" \
  'KRATOS_TOTP_ISSUER:?KRATOS_TOTP_ISSUER is required'
require_text "$REPO_ROOT/config/kratos.tpl.yml" \
  'allowed_origins: ${KRATOS_CORS_ALLOWED_ORIGINS_YAML}'
require_text "$REPO_ROOT/config/kratos.tpl.yml" \
  'issuer: ${KRATOS_TOTP_ISSUER}'

local_gateway_config="$SCRIPT_DIR/nginx/hydra-local.idnest.cloud.conf.example"
for gateway_contract in \
  'openid-configuration' \
  'oauth-authorization-server' \
  'jwks\.json' \
  'proxy_pass http://127.0.0.1:4444' \
  'proxy_hide_header Access-Control-Allow-Credentials' \
  'add_header Access-Control-Allow-Origin $idnest_public_metadata_cors_origin always' \
  'add_header Access-Control-Allow-Methods $idnest_public_metadata_cors_methods always'; do
  require_text "$local_gateway_config" "$gateway_contract"
done

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/idnest-cors-contract.XXXXXX")"
cleanup() {
  rm -rf -- "$temporary_directory"
}
trap cleanup EXIT INT TERM

HYDRA_DSN='postgres://hydra:test@db.invalid:5432/hydra?sslmode=disable' \
HYDRA_SECRETS_SYSTEM='0123456789abcdef0123456789abcdef' \
KRATOS_DSN='postgres://kratos:test@db.invalid:5432/kratos?sslmode=disable' \
KRATOS_CSRF_COOKIE_SECRET='0123456789abcdef0123456789abcdef' \
KRATOS_CIPHER_SECRET='0123456789abcdef0123456789abcdef' \
GOOGLE_CLIENT_ID='cors-contract-test' \
GOOGLE_CLIENT_SECRET='cors-contract-test-secret' \
  "$SCRIPT_DIR/render-development-identity-env.sh" \
  "$temporary_directory/identity.env" >/dev/null

require_line "$temporary_directory/identity.env" \
  "HYDRA_CORS_ALLOWED_ORIGINS='https://hydra-dev.idnest.cloud'"
require_line "$temporary_directory/identity.env" \
  "KRATOS_CORS_ALLOWED_ORIGINS='https://auth-dev.idnest.cloud'"
require_line "$temporary_directory/identity.env" \
  "KRATOS_TOTP_ISSUER='Idnest Development'"
reject_legacy_key "$temporary_directory/identity.env"
"$SCRIPT_DIR/vps/validate-app-env.sh" "$temporary_directory/identity.env" identity >/dev/null

sed \
  "s|^HYDRA_CORS_ALLOWED_ORIGINS=.*$|HYDRA_CORS_ALLOWED_ORIGINS='*'|" \
  "$temporary_directory/identity.env" > "$temporary_directory/wildcard-identity.env"
if "$SCRIPT_DIR/vps/validate-app-env.sh" "$temporary_directory/wildcard-identity.env" identity >/dev/null 2>&1; then
  fail "identity validation accepted a global Hydra CORS wildcard"
fi

AUTHZ_DATABASE_URL='postgres://authz:test@db.invalid:5432/authz?sslmode=disable' \
CONSENT_ACTION_SECRET='0123456789abcdef0123456789abcdef' \
AUTH_TRANSACTION_SECRET='0123456789abcdef0123456789abcdef' \
AUTH_AUDIT_HASH_SECRET='0123456789abcdef0123456789abcdef' \
ADMIN_BOOTSTRAP_EMAILS='cors-contract@idnest.cloud' \
  "$SCRIPT_DIR/render-development-app-env.sh" auth \
  "$temporary_directory/auth.env" >/dev/null

require_line "$temporary_directory/auth.env" \
  'AUTH_RETURN_TO_ALLOWED_ORIGINS=https://admin-dev.idnest.cloud'
require_line "$temporary_directory/auth.env" \
  'HYDRA_URLS_SELF_ISSUER=https://hydra-dev.idnest.cloud/'
reject_legacy_key "$temporary_directory/auth.env"

echo "Hydra, Kratos, and auth application CORS configuration contracts are aligned."
