#!/bin/sh
set -eu

fail() {
  echo "Development application environment rendering failed: $*" >&2
  exit 1
}

[ "$#" -eq 2 ] || fail "usage: render-development-app-env.sh auth|admin OUTPUT_FILE"
kind=$1
output_file=$2

case "$output_file" in
  ""|*/) fail "OUTPUT_FILE must include a filename" ;;
esac
[ ! -L "$output_file" ] || fail "refusing to replace symbolic link: $output_file"
output_directory=${output_file%/*}
[ "$output_directory" != "$output_file" ] || output_directory=.
[ -d "$output_directory" ] && [ ! -L "$output_directory" ] \
  || fail "output directory must be a regular directory: $output_directory"

for command in chmod dirname mktemp mv rm tr; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

safe_value() {
  key=$1
  value=$2
  [ -n "$value" ] || fail "$key is required"
  single_line=$(printf '%s' "$value" | tr -d '\015\012')
  [ "$single_line" = "$value" ] || fail "$key must be a single-line value"
  case "$value" in
    *replace-with-*|*change-me*|*todo*) fail "$key contains a placeholder" ;;
  esac
}

case "$kind" in
  auth)
    : "${AUTHZ_DATABASE_URL:?AUTHZ_DATABASE_URL is required}"
    : "${CONSENT_ACTION_SECRET:?CONSENT_ACTION_SECRET is required}"
    : "${AUTH_TRANSACTION_SECRET:?AUTH_TRANSACTION_SECRET is required}"
    : "${AUTH_AUDIT_HASH_SECRET:?AUTH_AUDIT_HASH_SECRET is required}"
    : "${ADMIN_BOOTSTRAP_EMAILS:?ADMIN_BOOTSTRAP_EMAILS is required}"
    safe_value AUTHZ_DATABASE_URL "$AUTHZ_DATABASE_URL"
    safe_value CONSENT_ACTION_SECRET "$CONSENT_ACTION_SECRET"
    safe_value AUTH_TRANSACTION_SECRET "$AUTH_TRANSACTION_SECRET"
    safe_value AUTH_AUDIT_HASH_SECRET "$AUTH_AUDIT_HASH_SECRET"
    safe_value ADMIN_BOOTSTRAP_EMAILS "$ADMIN_BOOTSTRAP_EMAILS"
    ;;
  admin)
    : "${AUTHZ_DATABASE_URL:?AUTHZ_DATABASE_URL is required}"
    : "${ADMIN_CSRF_SECRET:?ADMIN_CSRF_SECRET is required}"
    : "${ADMIN_OIDC_CLIENT_SECRET:?ADMIN_OIDC_CLIENT_SECRET is required}"
    : "${ADMIN_BOOTSTRAP_EMAILS:?ADMIN_BOOTSTRAP_EMAILS is required}"
    safe_value AUTHZ_DATABASE_URL "$AUTHZ_DATABASE_URL"
    safe_value ADMIN_CSRF_SECRET "$ADMIN_CSRF_SECRET"
    safe_value ADMIN_OIDC_CLIENT_SECRET "$ADMIN_OIDC_CLIENT_SECRET"
    safe_value ADMIN_BOOTSTRAP_EMAILS "$ADMIN_BOOTSTRAP_EMAILS"
    ;;
  *) fail "application kind must be auth or admin" ;;
esac

umask 077
candidate=$(mktemp "$output_directory/.app.env.XXXXXX")
cleanup() {
  rm -f -- "$candidate"
}
trap cleanup EXIT HUP INT TERM

case "$kind" in
  auth)
    {
      printf '%s\n' 'TLS_SERVER_NAME=auth-dev.idnest.cloud'
      printf '%s\n' 'HYDRA_ADMIN_URL=https://hydra-dev.idnest.cloud:4445'
      printf '%s\n' 'KRATOS_ADMIN_URL=http://idnest-kratos:4434'
      printf '%s\n' 'KRATOS_PUBLIC_URL=https://kratos-dev.idnest.cloud'
      printf '%s\n' 'KRATOS_INTERNAL_URL=https://kratos-dev.idnest.cloud:4433'
      printf '%s\n' 'HYDRA_URLS_SELF_ISSUER=https://hydra-dev.idnest.cloud/'
      printf '%s\n' 'AUTH_RETURN_TO_ALLOWED_ORIGINS=https://admin-dev.idnest.cloud'
      printf '%s\n' 'ADMIN_CORS_ALLOWED_ORIGINS=https://admin-dev.idnest.cloud'
      printf 'AUTHZ_DATABASE_URL=%s\n' "$AUTHZ_DATABASE_URL"
      printf '%s\n' 'CONSENT_GATE_MODE=observe'
      printf 'CONSENT_ACTION_SECRET=%s\n' "$CONSENT_ACTION_SECRET"
      printf '%s\n' 'AUTH_BRANDING_MODE=enforce'
      printf '%s\n' 'AUTH_STRICT_UNMAPPED_CLIENTS=false'
      printf '%s\n' 'AUTH_TRANSACTION_TTL_SECONDS=600'
      printf 'AUTH_TRANSACTION_SECRET=%s\n' "$AUTH_TRANSACTION_SECRET"
      printf 'AUTH_AUDIT_HASH_SECRET=%s\n' "$AUTH_AUDIT_HASH_SECRET"
      printf '%s\n' 'AUTH_ASSET_ALLOWED_ORIGINS=https://assets.idnest.cloud'
      printf '%s\n' 'AUTH_BASE_URL=https://auth-dev.idnest.cloud'
      printf '%s\n' 'ADMIN_PUBLIC_ORIGIN=https://admin-dev.idnest.cloud'
      printf 'ADMIN_BOOTSTRAP_EMAILS=%s\n' "$ADMIN_BOOTSTRAP_EMAILS"
    } >"$candidate"
    ;;
  admin)
    {
      printf '%s\n' 'TLS_SERVER_NAME=admin-dev.idnest.cloud'
      printf '%s\n' 'HYDRA_ADMIN_URL=https://hydra-dev.idnest.cloud:4445'
      printf '%s\n' 'KRATOS_ADMIN_URL=http://idnest-kratos:4434'
      printf '%s\n' 'KRATOS_PUBLIC_URL=https://kratos-dev.idnest.cloud'
      printf '%s\n' 'KRATOS_INTERNAL_URL=https://kratos-dev.idnest.cloud:4433'
      printf '%s\n' 'ADMIN_CORS_ALLOWED_ORIGINS=https://admin-dev.idnest.cloud'
      printf 'ADMIN_CSRF_SECRET=%s\n' "$ADMIN_CSRF_SECRET"
      printf 'AUTHZ_DATABASE_URL=%s\n' "$AUTHZ_DATABASE_URL"
      printf '%s\n' 'AUTH_ASSET_ALLOWED_ORIGINS=https://assets.idnest.cloud'
      printf '%s\n' 'ADMIN_PUBLIC_ORIGIN=https://admin-dev.idnest.cloud'
      printf 'ADMIN_BOOTSTRAP_EMAILS=%s\n' "$ADMIN_BOOTSTRAP_EMAILS"
      printf 'ADMIN_OIDC_CLIENT_SECRET=%s\n' "$ADMIN_OIDC_CLIENT_SECRET"
      printf '%s\n' 'ADMIN_OIDC_AUTHORITY=https://hydra-dev.idnest.cloud/'
      printf '%s\n' 'ADMIN_OIDC_TOKEN_URL=https://hydra-dev.idnest.cloud:4444/oauth2/token'
      printf '%s\n' 'ADMIN_OIDC_REDIRECT_URIS=https://admin-dev.idnest.cloud/api/admin/auth/callback'
      printf '%s\n' 'ADMIN_AUTH_POST_LOGOUT_REDIRECT_URIS=https://admin-dev.idnest.cloud/auth/logout'
      printf '%s\n' 'ADMIN_FRONTEND_API_BASE_URL=/api'
      printf '%s\n' 'ADMIN_FRONTEND_AUTH_LOGOUT_URL=https://auth-dev.idnest.cloud/logout'
    } >"$candidate"
    ;;
esac

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
"$SCRIPT_DIR/vps/validate-app-env.sh" "$candidate" "$kind" >/dev/null
chmod 600 "$candidate"
mv -- "$candidate" "$output_file"
candidate=
trap - EXIT HUP INT TERM
echo "Rendered validated $kind development application environment."
