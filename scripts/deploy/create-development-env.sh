#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Development environment generation failed: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/deploy/create-development-env.sh [DEVELOPMENT_ENV] [TERRAFORM_DIRECTORY]

Creates or overwrites the combined protected development environment file.

Defaults:
  DEVELOPMENT_ENV=tmp/development.env
  TERRAFORM_DIRECTORY=infrastructure/terraform/aws-development

The generator writes tracked development defaults, generates local database
passwords, DSNs, application secrets, and the delegation signing key. When
Terraform state is available, it also imports the non-secret AWS and VPS values.
External provider values such as Cloudflare, Google, and the bootstrap admin
email remain replace-with-* placeholders.
EOF
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
esac
[ "$#" -le 2 ] || { usage >&2; exit 2; }

for command in awk chmod dirname install mktemp mv openssl rm; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd "$SCRIPT_DIR/../.." && pwd)
DEVELOPMENT_ENV=${1:-$REPO_ROOT/tmp/development.env}
TERRAFORM_DIRECTORY=${2:-$REPO_ROOT/infrastructure/terraform/aws-development}

case "$DEVELOPMENT_ENV" in
  ""|*/) fail "DEVELOPMENT_ENV must include a filename" ;;
esac
[ ! -L "$DEVELOPMENT_ENV" ] || fail "refusing to replace symbolic link: $DEVELOPMENT_ENV"

development_filename=${DEVELOPMENT_ENV##*/}
development_directory=$(dirname "$DEVELOPMENT_ENV")
if [ -L "$development_directory" ]; then
  resolved_development_directory=$(CDPATH= cd "$development_directory" && pwd -P) \
    || fail "could not resolve development input directory: $development_directory"
  [ -d "$resolved_development_directory" ] \
    || fail "development input directory symlink target is invalid: $development_directory"
  development_directory=$resolved_development_directory
  DEVELOPMENT_ENV=$development_directory/$development_filename
fi
if [ -e "$development_directory" ] || [ -L "$development_directory" ]; then
  [ -d "$development_directory" ] && [ ! -L "$development_directory" ] \
    || fail "development input directory is invalid: $development_directory"
else
  install -d -m 700 "$development_directory" \
    || fail "could not create protected input directory: $development_directory"
fi

temporary_parent=${TMPDIR:-/tmp}
temporary_parent=${temporary_parent%/}
WORK_DIRECTORY=$(mktemp -d "$temporary_parent/idnest-development-env.XXXXXX")
candidate=$(mktemp "$development_directory/.development.env.XXXXXX")
cleanup() {
  rm -f -- "${candidate:-}"
  case "${WORK_DIRECTORY:-}" in
    "$temporary_parent"/idnest-development-env.*)
      [ ! -L "$WORK_DIRECTORY" ] && rm -rf -- "$WORK_DIRECTORY"
      ;;
  esac
}
trap cleanup EXIT HUP INT TERM
chmod 700 "$WORK_DIRECTORY"
chmod 600 "$candidate"

dotenv_value() {
  source_file=$1
  wanted_key=$2
  awk -v wanted="$wanted_key" '
    index($0, "=") > 0 {
      key = substr($0, 1, index($0, "=") - 1)
      if (key == wanted) {
        print substr($0, index($0, "=") + 1)
        exit
      }
    }
  ' "$source_file"
}

AWS_ACCOUNT_ID=replace-with-terraform-output
AWS_REGION=replace-with-terraform-output
AWS_BUILD_ROLE_ARN=replace-with-terraform-output
AUTH_AWS_DEPLOY_ROLE_ARN=replace-with-terraform-output
ADMIN_AWS_DEPLOY_ROLE_ARN=replace-with-terraform-output
AUTH_ECR_REPOSITORY=replace-with-terraform-output
ADMIN_ECR_REPOSITORY=replace-with-terraform-output
BUILDER_ECR_REPOSITORY=replace-with-terraform-output
VPS_HOST=replace-with-terraform-output
VPS_PORT=replace-with-terraform-output
VPS_USER=replace-with-terraform-output
terraform_values_loaded=false

if command -v terraform >/dev/null 2>&1 \
  && [ -d "$TERRAFORM_DIRECTORY" ] && [ ! -L "$TERRAFORM_DIRECTORY" ]; then
  terraform_output_directory=$WORK_DIRECTORY/terraform-vars
  if "$SCRIPT_DIR/render-github-environment-vars.sh" \
    "$TERRAFORM_DIRECTORY" \
    "$terraform_output_directory" >/dev/null 2>&1; then
    ecr_file=$terraform_output_directory/ecr-build.vars.env
    auth_file=$terraform_output_directory/development-auth.vars.env
    admin_file=$terraform_output_directory/development-admin.vars.env
    identity_file=$terraform_output_directory/development-identity.vars.env

    AWS_ACCOUNT_ID=$(dotenv_value "$ecr_file" AWS_ACCOUNT_ID)
    AWS_REGION=$(dotenv_value "$ecr_file" AWS_REGION)
    AWS_BUILD_ROLE_ARN=$(dotenv_value "$ecr_file" AWS_BUILD_ROLE_ARN)
    AUTH_AWS_DEPLOY_ROLE_ARN=$(dotenv_value "$auth_file" AWS_DEPLOY_ROLE_ARN)
    ADMIN_AWS_DEPLOY_ROLE_ARN=$(dotenv_value "$admin_file" AWS_DEPLOY_ROLE_ARN)
    AUTH_ECR_REPOSITORY=$(dotenv_value "$ecr_file" AUTH_ECR_REPOSITORY)
    ADMIN_ECR_REPOSITORY=$(dotenv_value "$ecr_file" ADMIN_ECR_REPOSITORY)
    BUILDER_ECR_REPOSITORY=$(dotenv_value "$ecr_file" BUILDER_ECR_REPOSITORY)
    VPS_HOST=$(dotenv_value "$identity_file" VPS_HOST)
    VPS_PORT=$(dotenv_value "$identity_file" VPS_PORT)
    VPS_USER=$(dotenv_value "$identity_file" VPS_USER)
    terraform_values_loaded=true
  fi
fi

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
  printf 'AWS_ACCOUNT_ID=%s\n' "$AWS_ACCOUNT_ID"
  printf 'AWS_REGION=%s\n' "$AWS_REGION"
  printf 'AWS_BUILD_ROLE_ARN=%s\n' "$AWS_BUILD_ROLE_ARN"
  printf 'AUTH_AWS_DEPLOY_ROLE_ARN=%s\n' "$AUTH_AWS_DEPLOY_ROLE_ARN"
  printf 'ADMIN_AWS_DEPLOY_ROLE_ARN=%s\n' "$ADMIN_AWS_DEPLOY_ROLE_ARN"
  printf 'AUTH_ECR_REPOSITORY=%s\n' "$AUTH_ECR_REPOSITORY"
  printf 'ADMIN_ECR_REPOSITORY=%s\n' "$ADMIN_ECR_REPOSITORY"
  printf 'BUILDER_ECR_REPOSITORY=%s\n' "$BUILDER_ECR_REPOSITORY"
  printf 'VPS_HOST=%s\n' "$VPS_HOST"
  printf 'VPS_PORT=%s\n' "$VPS_PORT"
  printf 'VPS_USER=%s\n' "$VPS_USER"
  printf '%s\n' 'CLOUDFLARE_TUNNEL_TOKEN=replace-with-cloudflare-tunnel-token'
  printf '%s\n' 'AUTH_URL=https://auth-dev.idnest.cloud'
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
  printf '%s\n' 'DELEGATION_ENABLED=false'
  printf 'DELEGATION_SIGNING_PRIVATE_KEY_B64=%s\n' "$DELEGATION_SIGNING_PRIVATE_KEY_B64"
  printf '%s\n' 'ADMIN_BOOTSTRAP_EMAILS=replace-with-real-admin-email-address'
  printf 'ADMIN_CSRF_SECRET=%s\n' "$ADMIN_CSRF_SECRET"
  printf 'ADMIN_OIDC_CLIENT_SECRET=%s\n' "$ADMIN_OIDC_CLIENT_SECRET"
} >"$candidate"

mv "$candidate" "$DEVELOPMENT_ENV"
candidate=
chmod 600 "$DEVELOPMENT_ENV"

if [ "$terraform_values_loaded" = true ]; then
  echo "Created $DEVELOPMENT_ENV with generated secrets, defaults, and Terraform-derived infrastructure values."
else
  echo "Created $DEVELOPMENT_ENV with generated secrets and defaults."
  echo "Terraform output was not available; run update-development-env-from-terraform.sh after terraform apply."
fi
echo "Replace remaining replace-with-* values before bootstrap or GitHub Environment upload."
