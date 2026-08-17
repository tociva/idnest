#!/bin/sh
set -eu

fail() {
  echo "Application environment validation failed: $*" >&2
  exit 1
}

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || fail "usage: validate-app-env.sh ENV_FILE [auth|admin|identity]"
env_file=$1
kind=${2:-}
[ -f "$env_file" ] && [ ! -L "$env_file" ] || fail "environment file must be a regular file"
[ -s "$env_file" ] || fail "environment file is empty"

case "$kind" in
  "") expected_keys= ;;
  auth)
    expected_keys='TLS_SERVER_NAME HYDRA_ADMIN_URL KRATOS_ADMIN_URL KRATOS_PUBLIC_URL KRATOS_INTERNAL_URL CORS_ALLOWED_ORIGINS ADMIN_CORS_ALLOWED_ORIGINS AUTHZ_DATABASE_URL CONSENT_GATE_MODE CONSENT_ACTION_SECRET AUTH_BRANDING_MODE AUTH_STRICT_UNMAPPED_CLIENTS AUTH_TRANSACTION_TTL_SECONDS AUTH_TRANSACTION_SECRET AUTH_AUDIT_HASH_SECRET AUTH_ASSET_ALLOWED_ORIGINS AUTH_LINK_ALLOWED_ORIGINS AUTH_BASE_URL ADMIN_PUBLIC_ORIGIN ADMIN_BOOTSTRAP_EMAILS'
    ;;
  admin)
    expected_keys='TLS_SERVER_NAME HYDRA_ADMIN_URL KRATOS_ADMIN_URL KRATOS_PUBLIC_URL KRATOS_INTERNAL_URL ADMIN_CORS_ALLOWED_ORIGINS ADMIN_CSRF_SECRET AUTHZ_DATABASE_URL AUTH_ASSET_ALLOWED_ORIGINS AUTH_LINK_ALLOWED_ORIGINS ADMIN_PUBLIC_ORIGIN ADMIN_BOOTSTRAP_EMAILS ADMIN_OIDC_CLIENT_SECRET ADMIN_OIDC_AUTHORITY ADMIN_OIDC_TOKEN_URL ADMIN_OIDC_REDIRECT_URIS ADMIN_AUTH_POST_LOGOUT_REDIRECT_URIS ADMIN_FRONTEND_API_BASE_URL ADMIN_FRONTEND_AUTH_LOGOUT_URL'
    ;;
  identity)
    expected_keys='AUTH_URL CORS_ALLOWED_ORIGINS HYDRA_DSN HYDRA_URLS_SELF_ISSUER HYDRA_URLS_CONSENT HYDRA_URLS_LOGIN HYDRA_URLS_LOGOUT HYDRA_URLS_POST_LOGOUT_REDIRECT HYDRA_URLS_ERROR HYDRA_SECRETS_SYSTEM KRATOS_DSN KRATOS_SERVE_PUBLIC_BASE_URL KRATOS_ADMIN_URL KRATOS_URLS_LOGOUT KRATOS_COOKIES_DOMAIN KRATOS_LOG_LEVEL KRATOS_CSRF_COOKIE_SECRET KRATOS_CIPHER_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET APPLE_CLIENT_ID APPLE_TEAM_ID APPLE_PRIVATE_KEY_ID APPLE_PRIVATE_KEY'
    ;;
  *) fail "environment kind must be auth, admin, or identity" ;;
esac

duplicates=$(
  awk '
    /^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/ {
      key=$0
      sub(/^[[:space:]]*/, "", key)
      sub(/[[:space:]]*=.*/, "", key)
      count[key]++
    }
    END { for (key in count) if (count[key] > 1) print key }
  ' "$env_file" | sort
)
[ -z "$duplicates" ] || fail "duplicate keys: $duplicates"

if grep -Eiq '(^|=)(replace-with-|change-?me|todo)([^A-Za-z0-9]|$)|@example\.com([,[:space:]]|$)|https?://[^,[:space:]]*\.example\.com([,[:space:]]|$)' "$env_file"; then
  fail "environment file contains placeholder values"
fi

if grep -Ev '^[[:space:]]*(#.*)?$|^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=.*$' "$env_file" | grep -q .; then
  fail "environment file contains a non KEY=value line"
fi

if [ -n "$expected_keys" ]; then
  awk -v expected="$expected_keys" -v source="$env_file" -v kind="$kind" '
    BEGIN {
      count = split(expected, keys, " ")
      for (idx = 1; idx <= count; idx++) required[keys[idx]] = 1
    }
    /^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/ {
      key = $0
      sub(/^[[:space:]]*/, "", key)
      sub(/[[:space:]]*=.*/, "", key)
      value = $0
      sub(/^[^=]*=/, "", value)
      sub(/^[[:space:]]*/, "", value)
      sub(/[[:space:]]*$/, "", value)
      if (value == "\"\"" || value == "\047\047") value = ""
      if (!(key in required)) {
        printf "Application environment validation failed: unexpected key %s in %s\n", key, source > "/dev/stderr"
        failed = 1
      }
      optional_identity_key = kind == "identity" && key ~ /^APPLE_(CLIENT_ID|TEAM_ID|PRIVATE_KEY_ID|PRIVATE_KEY)$/
      if (length(value) == 0 && !optional_identity_key) {
        printf "Application environment validation failed: empty value for %s in %s\n", key, source > "/dev/stderr"
        failed = 1
      }
      seen[key] = 1
    }
    END {
      for (key in required) {
        if (!(key in seen)) {
          printf "Application environment validation failed: missing key %s in %s\n", key, source > "/dev/stderr"
          failed = 1
        }
      }
      exit failed
    }
  ' "$env_file" || exit 1
fi

dotenv_value() {
  awk -v wanted="$1" '
    /^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/ {
      key = $0
      sub(/^[[:space:]]*/, "", key)
      sub(/[[:space:]]*=.*/, "", key)
      if (key == wanted) {
        value = $0
        sub(/^[^=]*=/, "", value)
        sub(/^[[:space:]]*/, "", value)
        sub(/[[:space:]]*$/, "", value)
        if (value ~ /^\".*\"$/ || value ~ /^\047.*\047$/) {
          value = substr(value, 2, length(value) - 2)
        }
        print value
        exit
      }
    }
  ' "$env_file"
}

if [ "$kind" = identity ]; then
  for identity_key in $expected_keys; do
    identity_value=$(dotenv_value "$identity_key")
    case "$identity_value" in
      *"'"*) fail "$identity_key must not contain a single quote" ;;
    esac
  done

  hydra_dsn=$(dotenv_value HYDRA_DSN)
  kratos_dsn=$(dotenv_value KRATOS_DSN)
  case "$hydra_dsn" in postgres://*|postgresql://*) ;; *) fail "HYDRA_DSN must be a PostgreSQL DSN" ;; esac
  case "$kratos_dsn" in postgres://*|postgresql://*) ;; *) fail "KRATOS_DSN must be a PostgreSQL DSN" ;; esac

  hydra_secret=$(dotenv_value HYDRA_SECRETS_SYSTEM)
  kratos_csrf_secret=$(dotenv_value KRATOS_CSRF_COOKIE_SECRET)
  kratos_cipher_secret=$(dotenv_value KRATOS_CIPHER_SECRET)
  [ "${#hydra_secret}" -ge 32 ] || fail "HYDRA_SECRETS_SYSTEM must contain at least 32 characters"
  [ "${#kratos_csrf_secret}" -ge 32 ] || fail "KRATOS_CSRF_COOKIE_SECRET must contain at least 32 characters"
  [ "${#kratos_cipher_secret}" -eq 32 ] || fail "KRATOS_CIPHER_SECRET must contain exactly 32 characters"

  apple_count=0
  for apple_key in APPLE_CLIENT_ID APPLE_TEAM_ID APPLE_PRIVATE_KEY_ID APPLE_PRIVATE_KEY; do
    [ -z "$(dotenv_value "$apple_key")" ] || apple_count=$((apple_count + 1))
  done
  case "$apple_count" in
    0|4) ;;
    *) fail "Apple login values must be either all configured or all empty" ;;
  esac
fi

echo "Application environment validation passed."
