#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Apple login contract test failed: $*" >&2
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
KEY_VALIDATOR="$REPO_ROOT/scripts/deploy/validate-apple-private-key.sh"
IDENTITY_RENDERER="$REPO_ROOT/scripts/deploy/render-development-identity-env.sh"
KRATOS_RENDERER="$REPO_ROOT/scripts/docker/render-kratos-config.sh"

for command in env envsubst grep mktemp openssl rg; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/idnest-apple-contract.XXXXXX")
cleanup() {
  rm -rf -- "$temporary_directory"
}
trap cleanup EXIT INT TERM

valid_key="$temporary_directory/apple-valid.p8"
rsa_key="$temporary_directory/apple-rsa.pem"
p384_key="$temporary_directory/apple-p384.p8"
sec1_key="$temporary_directory/apple-sec1.pem"

openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$valid_key" >/dev/null 2>&1
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$rsa_key" >/dev/null 2>&1
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-384 -out "$p384_key" >/dev/null 2>&1
openssl ecparam -name prime256v1 -genkey -noout -out "$sec1_key" >/dev/null 2>&1

"$KEY_VALIDATOR" "$valid_key" >/dev/null
for invalid_key in "$rsa_key" "$p384_key" "$sec1_key"; do
  if "$KEY_VALIDATOR" "$invalid_key" >/dev/null 2>&1; then
    fail "accepted an invalid Apple key: ${invalid_key##*/}"
  fi
done

valid_key_b64=$(openssl base64 -A -in "$valid_key")
common_identity_env=(
  HYDRA_DSN=postgres://hydra:test@db.invalid:5432/hydra?sslmode=disable
  HYDRA_SECRETS_SYSTEM=0123456789abcdef0123456789abcdef
  KRATOS_DSN=postgres://kratos:test@db.invalid:5432/kratos?sslmode=disable
  KRATOS_CSRF_COOKIE_SECRET=0123456789abcdef0123456789abcdef
  KRATOS_CIPHER_SECRET=0123456789abcdef0123456789abcdef
  GOOGLE_CLIENT_ID=google-contract-client
  GOOGLE_CLIENT_SECRET=google-contract-secret
)

enabled_env="$temporary_directory/apple-enabled.env"
env "${common_identity_env[@]}" \
  APPLE_CLIENT_ID=cloud.idnest.contract \
  APPLE_TEAM_ID=TEAMID1234 \
  APPLE_PRIVATE_KEY_ID=KEYID12345 \
  APPLE_PRIVATE_KEY_B64="$valid_key_b64" \
  "$IDENTITY_RENDERER" "$enabled_env" >/dev/null

grep -Fq "APPLE_CLIENT_ID='cloud.idnest.contract'" "$enabled_env" \
  || fail "enabled identity environment omitted APPLE_CLIENT_ID"
grep -Fq "APPLE_TEAM_ID='TEAMID1234'" "$enabled_env" \
  || fail "enabled identity environment omitted APPLE_TEAM_ID"
grep -Fq "APPLE_PRIVATE_KEY_ID='KEYID12345'" "$enabled_env" \
  || fail "enabled identity environment omitted APPLE_PRIVATE_KEY_ID"
grep -Fq 'APPLE_PRIVATE_KEY=' "$enabled_env" \
  || fail "enabled identity environment omitted APPLE_PRIVATE_KEY"

disabled_env="$temporary_directory/apple-disabled.env"
env "${common_identity_env[@]}" "$IDENTITY_RENDERER" "$disabled_env" >/dev/null
for apple_key in APPLE_CLIENT_ID APPLE_TEAM_ID APPLE_PRIVATE_KEY_ID APPLE_PRIVATE_KEY; do
  grep -Fq "${apple_key}=''" "$disabled_env" \
    || fail "disabled identity environment did not empty $apple_key"
done

if env "${common_identity_env[@]}" \
  APPLE_CLIENT_ID=cloud.idnest.contract \
  "$IDENTITY_RENDERER" "$temporary_directory/partial.env" >/dev/null 2>&1; then
  fail "partial Apple configuration was accepted"
fi

if env "${common_identity_env[@]}" \
  APPLE_CLIENT_ID=cloud.idnest.contract \
  APPLE_TEAM_ID=TEAMID1234 \
  APPLE_PRIVATE_KEY_ID=KEYID12345 \
  APPLE_PRIVATE_KEY_B64=dGVzdA== \
  "$IDENTITY_RENDERER" "$temporary_directory/invalid-key.env" >/dev/null 2>&1; then
  fail "invalid Apple private key was accepted"
fi

if env "${common_identity_env[@]}" \
  APPLE_CLIENT_ID=cloud.idnest.contract \
  APPLE_TEAM_ID=lowercase1 \
  APPLE_PRIVATE_KEY_ID=KEYID12345 \
  APPLE_PRIVATE_KEY_B64="$valid_key_b64" \
  "$IDENTITY_RENDERER" "$temporary_directory/invalid-id.env" >/dev/null 2>&1; then
  fail "invalid Apple Team ID was accepted"
fi

set -a
# shellcheck source=/dev/null
. "$enabled_env"
set +a
enabled_config="$temporary_directory/kratos-apple-enabled.yml"
"$KRATOS_RENDERER" "$REPO_ROOT/config/kratos.tpl.yml" "$enabled_config"
grep -Fq -- '- id: apple' "$enabled_config" || fail "rendered Kratos config omitted Apple"
grep -Fq 'provider: apple' "$enabled_config" || fail "rendered Kratos config omitted Apple provider type"
grep -Fq 'issuer_url: https://appleid.apple.com' "$enabled_config" \
  || fail "rendered Kratos config omitted the Apple issuer"
if rg -n '\$\{APPLE_' "$enabled_config" >/dev/null; then
  fail "rendered Kratos config contains unresolved Apple variables"
fi

raw_pem_config="$temporary_directory/kratos-apple-raw-pem.yml"
env "${common_identity_env[@]}" \
  AUTH_URL=https://auth-dev.idnest.cloud \
  KRATOS_CORS_ALLOWED_ORIGINS=https://auth-dev.idnest.cloud \
  KRATOS_TOTP_ISSUER='Idnest Development' \
  APPLE_CLIENT_ID=cloud.idnest.contract \
  APPLE_TEAM_ID=TEAMID1234 \
  APPLE_PRIVATE_KEY_ID=KEYID12345 \
  APPLE_PRIVATE_KEY="$(cat "$valid_key")" \
  "$KRATOS_RENDERER" "$REPO_ROOT/config/kratos.tpl.yml" "$raw_pem_config"
grep -Fq 'apple_private_key: "-----BEGIN PRIVATE KEY-----\n' "$raw_pem_config" \
  || fail "Kratos renderer did not YAML-encode a raw multiline Apple private key"

set -a
# shellcheck source=/dev/null
. "$disabled_env"
set +a
disabled_config="$temporary_directory/kratos-apple-disabled.yml"
"$KRATOS_RENDERER" "$REPO_ROOT/config/kratos.tpl.yml" "$disabled_config"
if grep -Fq -- '- id: apple' "$disabled_config"; then
  fail "rendered Kratos config included disabled Apple provider"
fi

if env "${common_identity_env[@]}" \
  AUTH_URL=https://auth-dev.idnest.cloud \
  KRATOS_CORS_ALLOWED_ORIGINS=https://auth-dev.idnest.cloud \
  KRATOS_TOTP_ISSUER='Idnest Development' \
  APPLE_CLIENT_ID=cloud.idnest.contract \
  "$KRATOS_RENDERER" "$REPO_ROOT/config/kratos.tpl.yml" "$temporary_directory/partial.yml" \
  >/dev/null 2>&1; then
  fail "Kratos renderer accepted partial Apple configuration"
fi

echo "Apple login contracts passed."
