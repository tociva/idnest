#!/bin/sh
set -eu

fail() {
  echo "Development identity environment rendering failed: $*" >&2
  exit 1
}

[ "$#" -eq 1 ] || fail "usage: render-development-identity-env.sh OUTPUT_FILE"
output_file=$1
case "$output_file" in
  ""|*/) fail "OUTPUT_FILE must include a filename" ;;
esac
[ ! -L "$output_file" ] || fail "refusing to replace symbolic link: $output_file"
output_directory=${output_file%/*}
[ "$output_directory" != "$output_file" ] || output_directory=.
[ -d "$output_directory" ] && [ ! -L "$output_directory" ] \
  || fail "output directory must be a regular directory: $output_directory"

for command in awk chmod dirname mktemp mv openssl rm tr; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

safe_required_value() {
  key=$1
  value=$2
  [ -n "$value" ] || fail "$key is required"
  single_line=$(printf '%s' "$value" | tr -d '\015\012')
  [ "$single_line" = "$value" ] || fail "$key must be a single-line value"
  case "$value" in
    *"'"*) fail "$key must not contain a single quote" ;;
    *replace-with-*|*change-me*|*todo*) fail "$key contains a placeholder" ;;
  esac
}

for key in \
  HYDRA_DSN HYDRA_SECRETS_SYSTEM KRATOS_DSN KRATOS_CSRF_COOKIE_SECRET \
  KRATOS_CIPHER_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET; do
  eval "value=\${$key:-}"
  safe_required_value "$key" "$value"
done

apple_value_count=0
for key in APPLE_CLIENT_ID APPLE_TEAM_ID APPLE_PRIVATE_KEY_ID APPLE_PRIVATE_KEY_B64; do
  eval "value=\${$key:-}"
  if [ -n "$value" ]; then
    apple_value_count=$((apple_value_count + 1))
    safe_required_value "$key" "$value"
  fi
done
case "$apple_value_count" in
  0|4) ;;
  *) fail "Apple login requires APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_PRIVATE_KEY_ID, and APPLE_PRIVATE_KEY_B64 together" ;;
esac

apple_private_key_yaml=
apple_key_file=
if [ "$apple_value_count" -eq 4 ]; then
  umask 077
  apple_key_file=$(mktemp "$output_directory/.apple-private-key.XXXXXX")
  printf '%s' "$APPLE_PRIVATE_KEY_B64" | openssl base64 -d -A >"$apple_key_file" 2>/dev/null \
    || fail "APPLE_PRIVATE_KEY_B64 is not valid base64"
  openssl pkey -in "$apple_key_file" -noout >/dev/null 2>&1 \
    || fail "APPLE_PRIVATE_KEY_B64 does not contain a valid PEM private key"
  apple_private_key_yaml=$(awk '
    BEGIN { printf "\"" }
    {
      gsub(/\\/, "\\\\")
      gsub(/\"/, "\\\"")
      gsub(/\r/, "")
      printf "%s\\n", $0
    }
    END { printf "\"" }
  ' "$apple_key_file")
fi

umask 077
candidate=$(mktemp "$output_directory/.idnest.env.XXXXXX")
cleanup() {
  rm -f -- "$candidate"
  [ -z "${apple_key_file:-}" ] || rm -f -- "$apple_key_file"
}
trap cleanup EXIT HUP INT TERM

{
  printf "%s\n" "AUTH_URL='https://auth-dev.idnest.cloud'"
  printf "%s\n" "HYDRA_CORS_ALLOWED_ORIGINS='https://hydra-dev.idnest.cloud'"
  printf "%s\n" "KRATOS_CORS_ALLOWED_ORIGINS='https://auth-dev.idnest.cloud'"
  printf "HYDRA_DSN='%s'\n" "$HYDRA_DSN"
  printf "%s\n" "HYDRA_URLS_SELF_ISSUER='https://hydra-dev.idnest.cloud/'"
  printf "%s\n" "HYDRA_URLS_CONSENT='https://auth-dev.idnest.cloud/oauth2/consent'"
  printf "%s\n" "HYDRA_URLS_LOGIN='https://auth-dev.idnest.cloud/oauth2/login'"
  printf "%s\n" "HYDRA_URLS_LOGOUT='https://auth-dev.idnest.cloud/logout'"
  printf "%s\n" "HYDRA_URLS_POST_LOGOUT_REDIRECT='https://admin-dev.idnest.cloud/auth/logout'"
  printf "%s\n" "HYDRA_URLS_ERROR='https://auth-dev.idnest.cloud/error'"
  printf "HYDRA_SECRETS_SYSTEM='%s'\n" "$HYDRA_SECRETS_SYSTEM"
  printf "KRATOS_DSN='%s'\n" "$KRATOS_DSN"
  printf "%s\n" "KRATOS_SERVE_PUBLIC_BASE_URL='https://kratos-dev.idnest.cloud'"
  printf "%s\n" "KRATOS_ADMIN_URL='http://localhost:4434'"
  printf "%s\n" "KRATOS_URLS_LOGOUT='https://hydra-dev.idnest.cloud/oauth2/sessions/logout'"
  printf "%s\n" "KRATOS_COOKIES_DOMAIN='.idnest.cloud'"
  printf "%s\n" "KRATOS_LOG_LEVEL='info'"
  printf "%s\n" "KRATOS_TOTP_ISSUER='Idnest Development'"
  printf "KRATOS_CSRF_COOKIE_SECRET='%s'\n" "$KRATOS_CSRF_COOKIE_SECRET"
  printf "KRATOS_CIPHER_SECRET='%s'\n" "$KRATOS_CIPHER_SECRET"
  printf "GOOGLE_CLIENT_ID='%s'\n" "$GOOGLE_CLIENT_ID"
  printf "GOOGLE_CLIENT_SECRET='%s'\n" "$GOOGLE_CLIENT_SECRET"
  printf "APPLE_CLIENT_ID='%s'\n" "${APPLE_CLIENT_ID:-}"
  printf "APPLE_TEAM_ID='%s'\n" "${APPLE_TEAM_ID:-}"
  printf "APPLE_PRIVATE_KEY_ID='%s'\n" "${APPLE_PRIVATE_KEY_ID:-}"
  printf "APPLE_PRIVATE_KEY='%s'\n" "$apple_private_key_yaml"
} >"$candidate"

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
"$SCRIPT_DIR/vps/validate-app-env.sh" "$candidate" identity >/dev/null
chmod 600 "$candidate"
mv -- "$candidate" "$output_file"
candidate=
[ -z "${apple_key_file:-}" ] || rm -f -- "$apple_key_file"
apple_key_file=
trap - EXIT HUP INT TERM
echo "Rendered validated development identity environment."
