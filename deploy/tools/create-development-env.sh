#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Development environment generation failed: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: deploy/tools/create-development-env.sh [DEVELOPMENT_ENV]

Creates or reconciles the combined protected development environment file.

Defaults:
  DEVELOPMENT_ENV=tmp/development.env
The generator writes tracked development defaults, generates missing local
database passwords, DSNs, application secrets, and the delegation signing key,
and removes keys that are no longer tracked. Existing manually configured
application values are preserved. Build infrastructure is intentionally kept
outside this runtime file. External provider values such as Google and the
bootstrap admin email remain replace-with-* placeholders until configured.
EOF
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
esac
[ "$#" -le 1 ] || { usage >&2; exit 2; }

for command in awk chmod dirname install mktemp mv openssl rm; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

SCRIPT_DIR=$(CDPATH='' cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd "$SCRIPT_DIR/../.." && pwd)
DEVELOPMENT_ENV=${1:-$REPO_ROOT/tmp/development.env}

case "$DEVELOPMENT_ENV" in
  ""|*/) fail "DEVELOPMENT_ENV must include a filename" ;;
esac
[ ! -L "$DEVELOPMENT_ENV" ] || fail "refusing to replace symbolic link: $DEVELOPMENT_ENV"

development_filename=${DEVELOPMENT_ENV##*/}
development_directory=$(dirname "$DEVELOPMENT_ENV")
if [ -L "$development_directory" ]; then
  resolved_development_directory=$(CDPATH='' cd "$development_directory" && pwd -P) \
    || fail "could not resolve development input directory: $development_directory"
  [ -d "$resolved_development_directory" ] \
    || fail "development input directory symlink target is invalid: $development_directory"
  development_directory=$resolved_development_directory
  DEVELOPMENT_ENV=$development_directory/$development_filename
fi
if [ -e "$development_directory" ] || [ -L "$development_directory" ]; then
  if [ ! -d "$development_directory" ] || [ -L "$development_directory" ]; then
    fail "development input directory is invalid: $development_directory"
  fi
else
  install -d -m 700 "$development_directory" \
    || fail "could not create protected input directory: $development_directory"
fi
if [ -e "$DEVELOPMENT_ENV" ]; then
  [ -f "$DEVELOPMENT_ENV" ] \
    || fail "development environment must be a regular file: $DEVELOPMENT_ENV"
fi

temporary_parent=${TMPDIR:-/tmp}
temporary_parent=${temporary_parent%/}
WORK_DIRECTORY=$(mktemp -d "$temporary_parent/idnest-development-env.XXXXXX")
candidate=$(mktemp "$development_directory/.development.env.XXXXXX")
merged_candidate=
cleanup() {
  rm -f -- "${candidate:-}" "${merged_candidate:-}"
  case "${WORK_DIRECTORY:-}" in
    "$temporary_parent"/idnest-development-env.*)
      [ ! -L "$WORK_DIRECTORY" ] && rm -rf -- "$WORK_DIRECTORY"
      ;;
  esac
}
trap cleanup EXIT HUP INT TERM
chmod 700 "$WORK_DIRECTORY"
chmod 600 "$candidate"

random_hex() {
  byte_count=$1
  openssl rand -hex "$byte_count"
}

HYDRA_DB_PASSWORD=$(random_hex 24)
KRATOS_DB_PASSWORD=$(random_hex 24)
AUTHZ_DB_PASSWORD=$(random_hex 24)

HYDRA_SECRETS_SYSTEM=$(random_hex 32)
KRATOS_CSRF_COOKIE_SECRET=$(random_hex 32)
KRATOS_CIPHER_SECRET=$(random_hex 16)
CONSENT_ACTION_SECRET=$(random_hex 32)
AUTH_TRANSACTION_SECRET=$(random_hex 32)
AUTH_AUDIT_HASH_SECRET=$(random_hex 32)
ADMIN_CSRF_SECRET=$(random_hex 32)
ADMIN_OIDC_CLIENT_SECRET=$(random_hex 32)

delegation_private_key=$WORK_DIRECTORY/delegation-private.pem
openssl genpkey -algorithm EC \
  -pkeyopt ec_paramgen_curve:P-256 \
  -out "$delegation_private_key" >/dev/null 2>&1 \
  || fail "could not generate delegation signing key"
DELEGATION_SIGNING_PRIVATE_KEY_B64=$(openssl base64 -A -in "$delegation_private_key")

{
  printf '%s\n' 'AUTH_URL=https://auth-dev.idnest.cloud'
  printf '%s\n' 'ECR_PUBLIC_REGISTRY=public.ecr.aws/replace-with-registry-alias'
  printf '%s\n' 'AUTH_ECR_REPOSITORY=idnest/auth-app'
  printf '%s\n' 'ADMIN_ECR_REPOSITORY=idnest/admin-app'
  printf '%s\n' 'SKIP_PUBLIC_HEALTH_CHECK=false'
  printf '%s\n' 'HYDRA_CORS_ALLOWED_ORIGINS=https://hydra-dev.idnest.cloud'
  printf '%s\n' 'KRATOS_CORS_ALLOWED_ORIGINS=https://auth-dev.idnest.cloud'
  printf 'HYDRA_DSN=postgres://hydrau:%s@host.docker.internal:5432/hydra?sslmode=disable\n' "$HYDRA_DB_PASSWORD"
  printf '%s\n' 'HYDRA_URLS_SELF_ISSUER=https://hydra-dev.idnest.cloud/'
  printf '%s\n' 'HYDRA_URLS_CONSENT=https://auth-dev.idnest.cloud/oauth2/consent'
  printf '%s\n' 'HYDRA_URLS_LOGIN=https://auth-dev.idnest.cloud/oauth2/login'
  printf '%s\n' 'HYDRA_URLS_LOGOUT=https://auth-dev.idnest.cloud/logout'
  printf '%s\n' 'HYDRA_URLS_POST_LOGOUT_REDIRECT=https://admin-dev.idnest.cloud/auth/logout'
  printf '%s\n' 'HYDRA_URLS_ERROR=https://auth-dev.idnest.cloud/error'
  printf 'HYDRA_SECRETS_SYSTEM=%s\n' "$HYDRA_SECRETS_SYSTEM"
  printf 'KRATOS_DSN=postgres://kratosu:%s@host.docker.internal:5432/kratos?sslmode=disable\n' "$KRATOS_DB_PASSWORD"
  printf '%s\n' 'KRATOS_SERVE_PUBLIC_BASE_URL=https://kratos-dev.idnest.cloud'
  printf '%s\n' 'KRATOS_ADMIN_URL=http://localhost:4434'
  printf '%s\n' 'KRATOS_URLS_LOGOUT=https://hydra-dev.idnest.cloud/oauth2/sessions/logout'
  printf '%s\n' 'KRATOS_COOKIES_DOMAIN=.idnest.cloud'
  printf '%s\n' 'KRATOS_LOG_LEVEL=info'
  printf "%s\n" "KRATOS_TOTP_ISSUER='Idnest Development'"
  printf 'KRATOS_CSRF_COOKIE_SECRET=%s\n' "$KRATOS_CSRF_COOKIE_SECRET"
  printf 'KRATOS_CIPHER_SECRET=%s\n' "$KRATOS_CIPHER_SECRET"
  printf '%s\n' 'GOOGLE_CLIENT_ID=replace-with-google-client-id'
  printf '%s\n' 'GOOGLE_CLIENT_SECRET=replace-with-google-client-secret'
  printf '%s\n' 'APPLE_CLIENT_ID='
  printf '%s\n' 'APPLE_TEAM_ID='
  printf '%s\n' 'APPLE_PRIVATE_KEY_ID='
  printf '%s\n' 'APPLE_PRIVATE_KEY='
  printf 'AUTHZ_DATABASE_URL=postgres://authzu:%s@host.docker.internal:5432/authz?sslmode=disable\n' "$AUTHZ_DB_PASSWORD"
  printf 'CONSENT_ACTION_SECRET=%s\n' "$CONSENT_ACTION_SECRET"
  printf 'AUTH_TRANSACTION_SECRET=%s\n' "$AUTH_TRANSACTION_SECRET"
  printf 'AUTH_AUDIT_HASH_SECRET=%s\n' "$AUTH_AUDIT_HASH_SECRET"
  printf 'DELEGATION_SIGNING_PRIVATE_KEY_B64=%s\n' "$DELEGATION_SIGNING_PRIVATE_KEY_B64"
  printf '%s\n' 'ADMIN_BOOTSTRAP_EMAILS=replace-with-real-admin-email-address'
  printf 'ADMIN_CSRF_SECRET=%s\n' "$ADMIN_CSRF_SECRET"
  printf 'ADMIN_OIDC_CLIENT_SECRET=%s\n' "$ADMIN_OIDC_CLIENT_SECRET"
} >"$candidate"

if [ -e "$DEVELOPMENT_ENV" ]; then
  merged_candidate=$(mktemp "$development_directory/.development.env.XXXXXX")
  chmod 600 "$merged_candidate"

  preserve_keys='ECR_PUBLIC_REGISTRY AUTH_ECR_REPOSITORY ADMIN_ECR_REPOSITORY SKIP_PUBLIC_HEALTH_CHECK HYDRA_DSN KRATOS_DSN HYDRA_SECRETS_SYSTEM KRATOS_CSRF_COOKIE_SECRET KRATOS_CIPHER_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET APPLE_CLIENT_ID APPLE_TEAM_ID APPLE_PRIVATE_KEY_ID APPLE_PRIVATE_KEY AUTHZ_DATABASE_URL CONSENT_ACTION_SECRET AUTH_TRANSACTION_SECRET AUTH_AUDIT_HASH_SECRET DELEGATION_SIGNING_PRIVATE_KEY_B64 ADMIN_BOOTSTRAP_EMAILS ADMIN_CSRF_SECRET ADMIN_OIDC_CLIENT_SECRET'

  awk -v preserve="$preserve_keys" '
    BEGIN {
      preserve_count = split(preserve, preserve_list, " ")
      for (idx = 1; idx <= preserve_count; idx++) {
        if (length(preserve_list[idx]) > 0) preserved[preserve_list[idx]] = 1
      }
    }
    /^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/ {
      separator = index($0, "=")
      key = substr($0, 1, separator - 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
      value = substr($0, separator + 1)
      if (NR == FNR) {
        generated_values[key] = value
        generated_order[++generated_count] = key
        generated_keys[key] = 1
      } else if ((key in generated_keys) && (key in preserved)) {
        existing_values[key] = value
      }
    }
    END {
      for (idx = 1; idx <= generated_count; idx++) {
        key = generated_order[idx]
        value = (key in existing_values) ? existing_values[key] : generated_values[key]
        print key "=" value
      }
    }
  ' "$candidate" "$DEVELOPMENT_ENV" >"$merged_candidate"

  mv "$merged_candidate" "$DEVELOPMENT_ENV"
  merged_candidate=
  rm -f -- "$candidate"
  candidate=
else
  mv "$candidate" "$DEVELOPMENT_ENV"
  candidate=
fi
chmod 600 "$DEVELOPMENT_ENV"

echo "Reconciled $DEVELOPMENT_ENV with runtime defaults."
echo "Replace remaining replace-with-* provider and application values before rendering VPS environments."
