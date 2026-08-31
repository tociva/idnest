#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo "Usage: $0 DEV_SSH_PRIVATE_KEY DEV_KNOWN_HOSTS DEV_RELEASE_SIGNING_KEY DEVELOPMENT_ENV OUTPUT_DIR" >&2
  exit 2
fi

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
APPLE_KEY_VALIDATOR="$SCRIPT_DIR/validate-apple-private-key.sh"
DEV_SSH_PRIVATE_KEY="$1"
DEV_KNOWN_HOSTS="$2"
DEV_RELEASE_SIGNING_PRIVATE_KEY="$3"
DEVELOPMENT_ENV="$4"
OUTPUT_DIR="$5"

for file in "$DEV_SSH_PRIVATE_KEY" "$DEV_KNOWN_HOSTS" "$DEV_RELEASE_SIGNING_PRIVATE_KEY" "$DEVELOPMENT_ENV"; do
  [ -f "$file" ] && [ ! -L "$file" ] && [ -s "$file" ] || {
    echo "Expected a non-empty regular file: $file" >&2
    exit 1
  }
done
for command in awk base64 chmod dirname grep install jq mktemp mv openssl rm ssh-keygen stat tr uname; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Missing required command: $command" >&2
    exit 1
  }
done
openssl pkey -in "$DEV_RELEASE_SIGNING_PRIVATE_KEY" -noout >/dev/null 2>&1 || {
  echo "Invalid host release signing private key: $DEV_RELEASE_SIGNING_PRIVATE_KEY" >&2
  exit 1
}
ssh-keygen -y -f "$DEV_SSH_PRIVATE_KEY" >/dev/null 2>&1 || {
  echo "Invalid or encrypted deployment SSH private key: $DEV_SSH_PRIVATE_KEY" >&2
  exit 1
}
ssh-keygen -l -f "$DEV_KNOWN_HOSTS" >/dev/null 2>&1 || {
  echo "Invalid SSH known-hosts file: $DEV_KNOWN_HOSTS" >&2
  exit 1
}

file_mode() {
  if [ "$(uname -s)" = Darwin ]; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

[ "$(file_mode "$DEVELOPMENT_ENV")" = 600 ] || {
  echo "Development environment file must have mode 600: $DEVELOPMENT_ENV" >&2
  exit 1
}
"$SCRIPT_DIR/vps/validate-app-env.sh" "$DEVELOPMENT_ENV" development-source >/dev/null

dotenv_value() {
  source_file=$1
  wanted_key=$2
  awk -v wanted="$wanted_key" '
    index($0, "=") > 0 {
      key = substr($0, 1, index($0, "=") - 1)
      if (key == wanted) {
        value = substr($0, index($0, "=") + 1)
        if (value ~ /^\".*\"$/ || value ~ /^\047.*\047$/) {
          value = substr(value, 2, length(value) - 2)
        }
        print value
        exit
      }
    }
  ' "$source_file"
}

dotenv_apple_private_key_yaml() {
  source_file=$1
  awk '
    index($0, "=") > 0 {
      key = substr($0, 1, index($0, "=") - 1)
      if (key == "APPLE_PRIVATE_KEY") {
        value = substr($0, index($0, "=") + 1)
        if (value ~ /^\047.*\047$/) value = substr(value, 2, length(value) - 2)
        print value
        exit
      }
    }
  ' "$source_file"
}

AUTH_AUTHZ_DATABASE_URL=$(dotenv_value "$DEVELOPMENT_ENV" AUTHZ_DATABASE_URL)
AUTH_CONSENT_ACTION_SECRET=$(dotenv_value "$DEVELOPMENT_ENV" CONSENT_ACTION_SECRET)
AUTH_TRANSACTION_SECRET_VALUE=$(dotenv_value "$DEVELOPMENT_ENV" AUTH_TRANSACTION_SECRET)
AUTH_AUDIT_HASH_SECRET_VALUE=$(dotenv_value "$DEVELOPMENT_ENV" AUTH_AUDIT_HASH_SECRET)
AUTH_DELEGATION_ENABLED=$(dotenv_value "$DEVELOPMENT_ENV" DELEGATION_ENABLED)
AUTH_DELEGATION_SIGNING_PRIVATE_KEY_B64=$(dotenv_value "$DEVELOPMENT_ENV" DELEGATION_SIGNING_PRIVATE_KEY_B64)
AUTH_ADMIN_BOOTSTRAP_EMAILS=$(dotenv_value "$DEVELOPMENT_ENV" ADMIN_BOOTSTRAP_EMAILS)
ADMIN_AUTHZ_DATABASE_URL=$AUTH_AUTHZ_DATABASE_URL
ADMIN_CSRF_SECRET_VALUE=$(dotenv_value "$DEVELOPMENT_ENV" ADMIN_CSRF_SECRET)
ADMIN_OIDC_CLIENT_SECRET_VALUE=$(dotenv_value "$DEVELOPMENT_ENV" ADMIN_OIDC_CLIENT_SECRET)
ADMIN_ADMIN_BOOTSTRAP_EMAILS=$AUTH_ADMIN_BOOTSTRAP_EMAILS
IDENTITY_HYDRA_DSN=$(dotenv_value "$DEVELOPMENT_ENV" HYDRA_DSN)
IDENTITY_HYDRA_SECRETS_SYSTEM=$(dotenv_value "$DEVELOPMENT_ENV" HYDRA_SECRETS_SYSTEM)
IDENTITY_KRATOS_DSN=$(dotenv_value "$DEVELOPMENT_ENV" KRATOS_DSN)
IDENTITY_KRATOS_CSRF_COOKIE_SECRET=$(dotenv_value "$DEVELOPMENT_ENV" KRATOS_CSRF_COOKIE_SECRET)
IDENTITY_KRATOS_CIPHER_SECRET=$(dotenv_value "$DEVELOPMENT_ENV" KRATOS_CIPHER_SECRET)
IDENTITY_GOOGLE_CLIENT_ID=$(dotenv_value "$DEVELOPMENT_ENV" GOOGLE_CLIENT_ID)
IDENTITY_GOOGLE_CLIENT_SECRET=$(dotenv_value "$DEVELOPMENT_ENV" GOOGLE_CLIENT_SECRET)
IDENTITY_APPLE_CLIENT_ID=$(dotenv_value "$DEVELOPMENT_ENV" APPLE_CLIENT_ID)
IDENTITY_APPLE_TEAM_ID=$(dotenv_value "$DEVELOPMENT_ENV" APPLE_TEAM_ID)
IDENTITY_APPLE_PRIVATE_KEY_ID=$(dotenv_value "$DEVELOPMENT_ENV" APPLE_PRIVATE_KEY_ID)
IDENTITY_APPLE_PRIVATE_KEY_YAML=$(dotenv_apple_private_key_yaml "$DEVELOPMENT_ENV")
AWS_ACCOUNT_ID=$(dotenv_value "$DEVELOPMENT_ENV" AWS_ACCOUNT_ID)
AWS_REGION=$(dotenv_value "$DEVELOPMENT_ENV" AWS_REGION)
AWS_BUILD_ROLE_ARN=$(dotenv_value "$DEVELOPMENT_ENV" AWS_BUILD_ROLE_ARN)
AUTH_AWS_DEPLOY_ROLE_ARN=$(dotenv_value "$DEVELOPMENT_ENV" AUTH_AWS_DEPLOY_ROLE_ARN)
ADMIN_AWS_DEPLOY_ROLE_ARN=$(dotenv_value "$DEVELOPMENT_ENV" ADMIN_AWS_DEPLOY_ROLE_ARN)
AUTH_ECR_REPOSITORY=$(dotenv_value "$DEVELOPMENT_ENV" AUTH_ECR_REPOSITORY)
ADMIN_ECR_REPOSITORY=$(dotenv_value "$DEVELOPMENT_ENV" ADMIN_ECR_REPOSITORY)
BUILDER_ECR_REPOSITORY=$(dotenv_value "$DEVELOPMENT_ENV" BUILDER_ECR_REPOSITORY)
VPS_HOST=$(dotenv_value "$DEVELOPMENT_ENV" VPS_HOST)
VPS_PORT=$(dotenv_value "$DEVELOPMENT_ENV" VPS_PORT)
VPS_USER=$(dotenv_value "$DEVELOPMENT_ENV" VPS_USER)
printf '%s' "$AUTH_DELEGATION_SIGNING_PRIVATE_KEY_B64" \
  | openssl base64 -d -A \
  | openssl pkey -text -noout 2>/dev/null \
  | grep -Eq 'ASN1 OID: prime256v1|NIST CURVE: P-256' \
  || { echo "DELEGATION_SIGNING_PRIVATE_KEY_B64 must contain a P-256 private key." >&2; exit 1; }
IDENTITY_APPLE_PRIVATE_KEY=
IDENTITY_APPLE_ENABLED=false
IDENTITY_APPLE_PRIVATE_KEY_FILE=
cleanup() {
  [ -z "${IDENTITY_APPLE_PRIVATE_KEY_FILE:-}" ] || rm -f -- "$IDENTITY_APPLE_PRIVATE_KEY_FILE"
}
trap cleanup EXIT HUP INT TERM
if [ -n "$IDENTITY_APPLE_PRIVATE_KEY_YAML" ]; then
  IDENTITY_APPLE_PRIVATE_KEY=$(printf '%s' "$IDENTITY_APPLE_PRIVATE_KEY_YAML" | jq -er 'select(type == "string" and length > 0)') \
    || { echo "APPLE_PRIVATE_KEY in $DEVELOPMENT_ENV must be a JSON-compatible double-quoted YAML string." >&2; exit 1; }
  IDENTITY_APPLE_PRIVATE_KEY_FILE=$(mktemp "${TMPDIR:-/tmp}/idnest-apple-private-key.XXXXXX")
  chmod 600 "$IDENTITY_APPLE_PRIVATE_KEY_FILE"
  printf '%s' "$IDENTITY_APPLE_PRIVATE_KEY" >"$IDENTITY_APPLE_PRIVATE_KEY_FILE"
  "$APPLE_KEY_VALIDATOR" "$IDENTITY_APPLE_PRIVATE_KEY_FILE" >/dev/null \
    || { echo "APPLE_PRIVATE_KEY in $DEVELOPMENT_ENV must be an Apple PKCS#8 P-256 private key." >&2; exit 1; }
  rm -f -- "$IDENTITY_APPLE_PRIVATE_KEY_FILE"
  IDENTITY_APPLE_PRIVATE_KEY_FILE=
  IDENTITY_APPLE_ENABLED=true
fi

if [ -e "$OUTPUT_DIR" ]; then
  [ -d "$OUTPUT_DIR" ] && [ ! -L "$OUTPUT_DIR" ] || {
    echo "Output directory must not be a symbolic link: $OUTPUT_DIR" >&2
    exit 1
  }
else
  install -d -m 700 "$OUTPUT_DIR"
fi
chmod 700 "$OUTPUT_DIR"

write_variables() {
  destination=$1
  environment=$2
  [ ! -L "$destination" ] || {
    echo "Refusing to replace symbolic link: $destination" >&2
    exit 1
  }
  umask 077
  temporary=$(mktemp "$OUTPUT_DIR/.vars.env.XXXXXX")
  case "$environment" in
    ecr-build)
      {
        printf 'AWS_ACCOUNT_ID=%s\n' "$AWS_ACCOUNT_ID"
        printf 'AWS_REGION=%s\n' "$AWS_REGION"
        printf 'AWS_BUILD_ROLE_ARN=%s\n' "$AWS_BUILD_ROLE_ARN"
        printf 'AUTH_ECR_REPOSITORY=%s\n' "$AUTH_ECR_REPOSITORY"
        printf 'ADMIN_ECR_REPOSITORY=%s\n' "$ADMIN_ECR_REPOSITORY"
        printf 'BUILDER_ECR_REPOSITORY=%s\n' "$BUILDER_ECR_REPOSITORY"
      } >"$temporary"
      ;;
    development-auth)
      {
        printf 'AWS_ACCOUNT_ID=%s\n' "$AWS_ACCOUNT_ID"
        printf 'AWS_REGION=%s\n' "$AWS_REGION"
        printf 'AWS_DEPLOY_ROLE_ARN=%s\n' "$AUTH_AWS_DEPLOY_ROLE_ARN"
        printf 'ECR_REPOSITORY=%s\n' "$AUTH_ECR_REPOSITORY"
        printf 'VPS_HOST=%s\n' "$VPS_HOST"
        printf 'VPS_PORT=%s\n' "$VPS_PORT"
        printf 'VPS_USER=%s\n' "$VPS_USER"
        printf 'ADMIN_BOOTSTRAP_EMAILS=%s\n' "$AUTH_ADMIN_BOOTSTRAP_EMAILS"
        printf 'DELEGATION_ENABLED=%s\n' "$AUTH_DELEGATION_ENABLED"
      } >"$temporary"
      ;;
    development-admin)
      {
        printf 'AWS_ACCOUNT_ID=%s\n' "$AWS_ACCOUNT_ID"
        printf 'AWS_REGION=%s\n' "$AWS_REGION"
        printf 'AWS_DEPLOY_ROLE_ARN=%s\n' "$ADMIN_AWS_DEPLOY_ROLE_ARN"
        printf 'ECR_REPOSITORY=%s\n' "$ADMIN_ECR_REPOSITORY"
        printf 'VPS_HOST=%s\n' "$VPS_HOST"
        printf 'VPS_PORT=%s\n' "$VPS_PORT"
        printf 'VPS_USER=%s\n' "$VPS_USER"
        printf 'ADMIN_BOOTSTRAP_EMAILS=%s\n' "$ADMIN_ADMIN_BOOTSTRAP_EMAILS"
      } >"$temporary"
      ;;
    development-identity)
      {
        printf 'VPS_HOST=%s\n' "$VPS_HOST"
        printf 'VPS_PORT=%s\n' "$VPS_PORT"
        printf 'VPS_USER=%s\n' "$VPS_USER"
        printf 'GOOGLE_CLIENT_ID=%s\n' "$IDENTITY_GOOGLE_CLIENT_ID"
        if [ "$IDENTITY_APPLE_ENABLED" = true ]; then
          printf 'APPLE_CLIENT_ID=%s\n' "$IDENTITY_APPLE_CLIENT_ID"
          printf 'APPLE_TEAM_ID=%s\n' "$IDENTITY_APPLE_TEAM_ID"
          printf 'APPLE_PRIVATE_KEY_ID=%s\n' "$IDENTITY_APPLE_PRIVATE_KEY_ID"
        fi
      } >"$temporary"
      ;;
    *)
      echo "Unsupported GitHub variable environment: $environment" >&2
      exit 1
      ;;
  esac
  chmod 600 "$temporary"
  mv "$temporary" "$destination"
}

write_variables "$OUTPUT_DIR/ecr-build.vars.env" ecr-build
write_variables "$OUTPUT_DIR/development-auth.vars.env" development-auth
write_variables "$OUTPUT_DIR/development-admin.vars.env" development-admin
write_variables "$OUTPUT_DIR/development-identity.vars.env" development-identity

write_secrets() {
  destination=$1
  environment=$2
  ssh_private_key=$3
  known_hosts=$4
  signing_key=$5
  [ ! -L "$destination" ] || {
    echo "Refusing to replace symbolic link: $destination" >&2
    exit 1
  }
  umask 077
  temporary=$(mktemp "$OUTPUT_DIR/.secrets.env.XXXXXX")
  {
    printf 'VPS_SSH_PRIVATE_KEY_B64='; base64 <"$ssh_private_key" | tr -d '\n'; echo
    printf 'VPS_SSH_KNOWN_HOSTS_B64='; base64 <"$known_hosts" | tr -d '\n'; echo
    printf 'HOST_RELEASE_SIGNING_PRIVATE_KEY_B64='; base64 <"$signing_key" | tr -d '\n'; echo
    case "$environment" in
      auth)
        printf 'AUTHZ_DATABASE_URL=%s\n' "$AUTH_AUTHZ_DATABASE_URL"
        printf 'CONSENT_ACTION_SECRET=%s\n' "$AUTH_CONSENT_ACTION_SECRET"
        printf 'AUTH_TRANSACTION_SECRET=%s\n' "$AUTH_TRANSACTION_SECRET_VALUE"
        printf 'AUTH_AUDIT_HASH_SECRET=%s\n' "$AUTH_AUDIT_HASH_SECRET_VALUE"
        printf 'DELEGATION_SIGNING_PRIVATE_KEY_B64=%s\n' "$AUTH_DELEGATION_SIGNING_PRIVATE_KEY_B64"
        ;;
      admin)
        printf 'AUTHZ_DATABASE_URL=%s\n' "$ADMIN_AUTHZ_DATABASE_URL"
        printf 'ADMIN_CSRF_SECRET=%s\n' "$ADMIN_CSRF_SECRET_VALUE"
        printf 'ADMIN_OIDC_CLIENT_SECRET=%s\n' "$ADMIN_OIDC_CLIENT_SECRET_VALUE"
        ;;
      identity)
        printf 'HYDRA_DSN=%s\n' "$IDENTITY_HYDRA_DSN"
        printf 'HYDRA_SECRETS_SYSTEM=%s\n' "$IDENTITY_HYDRA_SECRETS_SYSTEM"
        printf 'KRATOS_DSN=%s\n' "$IDENTITY_KRATOS_DSN"
        printf 'KRATOS_CSRF_COOKIE_SECRET=%s\n' "$IDENTITY_KRATOS_CSRF_COOKIE_SECRET"
        printf 'KRATOS_CIPHER_SECRET=%s\n' "$IDENTITY_KRATOS_CIPHER_SECRET"
        printf 'GOOGLE_CLIENT_SECRET=%s\n' "$IDENTITY_GOOGLE_CLIENT_SECRET"
        if [ "$IDENTITY_APPLE_ENABLED" = true ]; then
          printf 'APPLE_PRIVATE_KEY_B64='; printf '%s' "$IDENTITY_APPLE_PRIVATE_KEY" | base64 | tr -d '\n'; echo
        fi
        ;;
      *)
        echo "Unsupported application environment: $environment" >&2
        exit 1
        ;;
    esac
  } >"$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$destination"
}

write_secrets "$OUTPUT_DIR/development-auth.secrets.env" auth "$DEV_SSH_PRIVATE_KEY" "$DEV_KNOWN_HOSTS" "$DEV_RELEASE_SIGNING_PRIVATE_KEY"
write_secrets "$OUTPUT_DIR/development-admin.secrets.env" admin "$DEV_SSH_PRIVATE_KEY" "$DEV_KNOWN_HOSTS" "$DEV_RELEASE_SIGNING_PRIVATE_KEY"
write_secrets "$OUTPUT_DIR/development-identity.secrets.env" identity "$DEV_SSH_PRIVATE_KEY" "$DEV_KNOWN_HOSTS" "$DEV_RELEASE_SIGNING_PRIVATE_KEY"
echo "Prepared development GitHub variable and secret dotenv files in $OUTPUT_DIR. Values were not printed."
