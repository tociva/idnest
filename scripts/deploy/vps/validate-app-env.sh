#!/bin/sh
set -eu

fail() {
  echo "Application environment validation failed: $*" >&2
  exit 1
}

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || fail "usage: validate-app-env.sh ENV_FILE [auth|admin|identity|development-source]"
env_file=$1
kind=${2:-}
[ -f "$env_file" ] && [ ! -L "$env_file" ] || fail "environment file must be a regular file"
[ -s "$env_file" ] || fail "environment file is empty"

case "$kind" in
  "") expected_keys= ;;
  auth)
    expected_keys='TLS_SERVER_NAME HYDRA_ADMIN_URL KRATOS_ADMIN_URL KRATOS_PUBLIC_URL KRATOS_INTERNAL_URL AUTH_RETURN_TO_ALLOWED_ORIGINS ADMIN_CORS_ALLOWED_ORIGINS AUTHZ_DATABASE_URL CONSENT_GATE_MODE CONSENT_ACTION_SECRET AUTH_BRANDING_MODE AUTH_STRICT_UNMAPPED_CLIENTS AUTH_TRANSACTION_TTL_SECONDS AUTH_TRANSACTION_SECRET AUTH_AUDIT_HASH_SECRET AUTH_ASSET_ALLOWED_ORIGINS AUTH_BASE_URL ADMIN_PUBLIC_ORIGIN ADMIN_BOOTSTRAP_EMAILS'
    ;;
  admin)
    expected_keys='TLS_SERVER_NAME HYDRA_ADMIN_URL KRATOS_ADMIN_URL KRATOS_PUBLIC_URL KRATOS_INTERNAL_URL ADMIN_CORS_ALLOWED_ORIGINS ADMIN_CSRF_SECRET AUTHZ_DATABASE_URL AUTH_ASSET_ALLOWED_ORIGINS ADMIN_PUBLIC_ORIGIN ADMIN_BOOTSTRAP_EMAILS ADMIN_OIDC_CLIENT_SECRET ADMIN_OIDC_AUTHORITY ADMIN_OIDC_TOKEN_URL ADMIN_OIDC_REDIRECT_URIS ADMIN_AUTH_POST_LOGOUT_REDIRECT_URIS ADMIN_FRONTEND_API_BASE_URL ADMIN_FRONTEND_AUTH_LOGOUT_URL'
    ;;
  identity)
    expected_keys='AUTH_URL HYDRA_CORS_ALLOWED_ORIGINS KRATOS_CORS_ALLOWED_ORIGINS HYDRA_DSN HYDRA_URLS_SELF_ISSUER HYDRA_URLS_CONSENT HYDRA_URLS_LOGIN HYDRA_URLS_LOGOUT HYDRA_URLS_POST_LOGOUT_REDIRECT HYDRA_URLS_ERROR HYDRA_SECRETS_SYSTEM KRATOS_DSN KRATOS_SERVE_PUBLIC_BASE_URL KRATOS_ADMIN_URL KRATOS_URLS_LOGOUT KRATOS_COOKIES_DOMAIN KRATOS_LOG_LEVEL KRATOS_TOTP_ISSUER KRATOS_CSRF_COOKIE_SECRET KRATOS_CIPHER_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET APPLE_CLIENT_ID APPLE_TEAM_ID APPLE_PRIVATE_KEY_ID APPLE_PRIVATE_KEY'
    ;;
  development-source)
    expected_keys='AWS_ACCOUNT_ID AWS_REGION AWS_BUILD_ROLE_ARN AUTH_AWS_DEPLOY_ROLE_ARN ADMIN_AWS_DEPLOY_ROLE_ARN AUTH_ECR_REPOSITORY ADMIN_ECR_REPOSITORY VPS_HOST VPS_PORT VPS_USER AUTH_URL HYDRA_CORS_ALLOWED_ORIGINS KRATOS_CORS_ALLOWED_ORIGINS HYDRA_DSN HYDRA_URLS_SELF_ISSUER HYDRA_URLS_CONSENT HYDRA_URLS_LOGIN HYDRA_URLS_LOGOUT HYDRA_URLS_POST_LOGOUT_REDIRECT HYDRA_URLS_ERROR HYDRA_SECRETS_SYSTEM KRATOS_DSN KRATOS_SERVE_PUBLIC_BASE_URL KRATOS_ADMIN_URL KRATOS_URLS_LOGOUT KRATOS_COOKIES_DOMAIN KRATOS_LOG_LEVEL KRATOS_TOTP_ISSUER KRATOS_CSRF_COOKIE_SECRET KRATOS_CIPHER_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET APPLE_CLIENT_ID APPLE_TEAM_ID APPLE_PRIVATE_KEY_ID APPLE_PRIVATE_KEY AUTHZ_DATABASE_URL CONSENT_ACTION_SECRET AUTH_TRANSACTION_SECRET AUTH_AUDIT_HASH_SECRET ADMIN_BOOTSTRAP_EMAILS ADMIN_CSRF_SECRET ADMIN_OIDC_CLIENT_SECRET'
    ;;
  *) fail "environment kind must be auth, admin, identity, or development-source" ;;
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

if grep -Eiq 'replace-with-|=[[:space:]]*(change-?me|todo)|=[[:space:]]*[xX]{3,}[[:space:]]*$|@example\.com([,[:space:]]|$)|https?://[^,[:space:]]*\.example\.com([,[:space:]]|$)' "$env_file"; then
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
      optional_identity_key = (kind == "identity" || kind == "development-source") && key ~ /^APPLE_(CLIENT_ID|TEAM_ID|PRIVATE_KEY_ID|PRIVATE_KEY)$/
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

if [ "$kind" = identity ] || [ "$kind" = development-source ]; then
  for identity_key in $expected_keys; do
    identity_value=$(dotenv_value "$identity_key")
    case "$identity_value" in
      *"'"*) fail "$identity_key must not contain a single quote" ;;
    esac
  done

  hydra_dsn=$(dotenv_value HYDRA_DSN)
  kratos_dsn=$(dotenv_value KRATOS_DSN)
  hydra_cors_allowed_origins=$(dotenv_value HYDRA_CORS_ALLOWED_ORIGINS)
  case "$hydra_dsn" in postgres://*|postgresql://*) ;; *) fail "HYDRA_DSN must be a PostgreSQL DSN" ;; esac
  case "$kratos_dsn" in postgres://*|postgresql://*) ;; *) fail "KRATOS_DSN must be a PostgreSQL DSN" ;; esac
  [ "$hydra_cors_allowed_origins" != '*' ] \
    || fail "HYDRA_CORS_ALLOWED_ORIGINS must not allow every browser origin"

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

if [ "$kind" = development-source ]; then
  aws_account_id=$(dotenv_value AWS_ACCOUNT_ID)
  aws_region=$(dotenv_value AWS_REGION)
  aws_build_role_arn=$(dotenv_value AWS_BUILD_ROLE_ARN)
  auth_aws_deploy_role_arn=$(dotenv_value AUTH_AWS_DEPLOY_ROLE_ARN)
  admin_aws_deploy_role_arn=$(dotenv_value ADMIN_AWS_DEPLOY_ROLE_ARN)
  auth_ecr_repository=$(dotenv_value AUTH_ECR_REPOSITORY)
  admin_ecr_repository=$(dotenv_value ADMIN_ECR_REPOSITORY)
  vps_host=$(dotenv_value VPS_HOST)
  vps_port=$(dotenv_value VPS_PORT)
  vps_user=$(dotenv_value VPS_USER)

  printf '%s\n' "$aws_account_id" | grep -Eq '^[0-9]{12}$' \
    || fail "AWS_ACCOUNT_ID must be a 12-digit AWS account ID"
  printf '%s\n' "$aws_region" | grep -Eq '^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$' \
    || fail "AWS_REGION is not a valid AWS region"
  for role_entry in \
    "AWS_BUILD_ROLE_ARN=$aws_build_role_arn" \
    "AUTH_AWS_DEPLOY_ROLE_ARN=$auth_aws_deploy_role_arn" \
    "ADMIN_AWS_DEPLOY_ROLE_ARN=$admin_aws_deploy_role_arn"; do
    role_key=${role_entry%%=*}
    role_value=${role_entry#*=}
    printf '%s\n' "$role_value" \
      | grep -Eq "^arn:aws:iam::${aws_account_id}:role/[A-Za-z0-9+=,.@_/-]+$" \
      || fail "$role_key is not a valid IAM role ARN for AWS_ACCOUNT_ID"
  done
  for repository_entry in \
    "AUTH_ECR_REPOSITORY=$auth_ecr_repository" \
    "ADMIN_ECR_REPOSITORY=$admin_ecr_repository"; do
    repository_key=${repository_entry%%=*}
    repository_value=${repository_entry#*=}
    printf '%s\n' "$repository_value" | grep -Eq '^[a-z0-9][a-z0-9._/-]*$' \
      || fail "$repository_key is not a valid ECR repository name"
  done
  printf '%s\n' "$vps_host" | grep -Eq '^[A-Za-z0-9.-]+$' \
    || fail "VPS_HOST is not a valid hostname or IP address"
  printf '%s\n' "$vps_port" | grep -Eq '^[0-9]{1,5}$' \
    || fail "VPS_PORT is not a valid TCP port"
  [ "$vps_port" -ge 1 ] && [ "$vps_port" -le 65535 ] \
    || fail "VPS_PORT is not a valid TCP port"
  printf '%s\n' "$vps_user" | grep -Eq '^[A-Za-z_][A-Za-z0-9._-]*$' \
    || fail "VPS_USER is not a valid SSH user"

  authz_dsn=$(dotenv_value AUTHZ_DATABASE_URL)
  case "$authz_dsn" in postgres://*|postgresql://*) ;; *) fail "AUTHZ_DATABASE_URL must be a PostgreSQL DSN" ;; esac

  require_development_default() {
    default_key=$1
    expected_value=$2
    actual_value=$(dotenv_value "$default_key")
    [ "$actual_value" = "$expected_value" ] \
      || fail "$default_key must keep the tracked development default: $expected_value"
  }
  require_development_default AUTH_URL 'https://auth-dev.idnest.cloud'
  require_development_default HYDRA_CORS_ALLOWED_ORIGINS 'https://hydra-dev.idnest.cloud,https://app-dev.daybook.cloud'
  require_development_default KRATOS_CORS_ALLOWED_ORIGINS 'https://auth-dev.idnest.cloud'
  require_development_default HYDRA_URLS_SELF_ISSUER 'https://hydra-dev.idnest.cloud/'
  require_development_default HYDRA_URLS_CONSENT 'https://auth-dev.idnest.cloud/oauth2/consent'
  require_development_default HYDRA_URLS_LOGIN 'https://auth-dev.idnest.cloud/oauth2/login'
  require_development_default HYDRA_URLS_LOGOUT 'https://auth-dev.idnest.cloud/logout'
  require_development_default HYDRA_URLS_POST_LOGOUT_REDIRECT 'https://admin-dev.idnest.cloud/auth/logout'
  require_development_default HYDRA_URLS_ERROR 'https://auth-dev.idnest.cloud/error'
  require_development_default KRATOS_SERVE_PUBLIC_BASE_URL 'https://kratos-dev.idnest.cloud'
  require_development_default KRATOS_ADMIN_URL 'http://localhost:4434'
  require_development_default KRATOS_URLS_LOGOUT 'https://hydra-dev.idnest.cloud/oauth2/sessions/logout'
  require_development_default KRATOS_COOKIES_DOMAIN '.idnest.cloud'
  require_development_default KRATOS_LOG_LEVEL 'info'
  require_development_default KRATOS_TOTP_ISSUER 'Idnest Development'
fi

echo "Application environment validation passed."
