#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 6 ]; then
  echo "Usage: $0 DEV_SSH_PRIVATE_KEY DEV_KNOWN_HOSTS DEV_RELEASE_SIGNING_KEY AUTH_APP_ENV ADMIN_APP_ENV OUTPUT_DIR" >&2
  exit 2
fi

DEV_SSH_PRIVATE_KEY="$1"
DEV_KNOWN_HOSTS="$2"
DEV_RELEASE_SIGNING_PRIVATE_KEY="$3"
AUTH_APP_ENV="$4"
ADMIN_APP_ENV="$5"
OUTPUT_DIR="$6"

for file in "$DEV_SSH_PRIVATE_KEY" "$DEV_KNOWN_HOSTS" "$DEV_RELEASE_SIGNING_PRIVATE_KEY" "$AUTH_APP_ENV" "$ADMIN_APP_ENV"; do
  [ -f "$file" ] && [ ! -L "$file" ] && [ -s "$file" ] || {
    echo "Expected a non-empty regular file: $file" >&2
    exit 1
  }
done
for command in awk base64 chmod dirname grep install mktemp mv openssl ssh-keygen stat tr uname; do
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

for app_env in "$AUTH_APP_ENV" "$ADMIN_APP_ENV"; do
  [ "$(file_mode "$app_env")" = 600 ] || {
    echo "Application environment file must have mode 600: $app_env" >&2
    exit 1
  }
done
SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
"$SCRIPT_DIR/vps/validate-app-env.sh" "$AUTH_APP_ENV" auth >/dev/null
"$SCRIPT_DIR/vps/validate-app-env.sh" "$ADMIN_APP_ENV" admin >/dev/null

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

AUTH_AUTHZ_DATABASE_URL=$(dotenv_value "$AUTH_APP_ENV" AUTHZ_DATABASE_URL)
AUTH_CONSENT_ACTION_SECRET=$(dotenv_value "$AUTH_APP_ENV" CONSENT_ACTION_SECRET)
AUTH_TRANSACTION_SECRET_VALUE=$(dotenv_value "$AUTH_APP_ENV" AUTH_TRANSACTION_SECRET)
AUTH_AUDIT_HASH_SECRET_VALUE=$(dotenv_value "$AUTH_APP_ENV" AUTH_AUDIT_HASH_SECRET)
AUTH_ADMIN_BOOTSTRAP_EMAILS=$(dotenv_value "$AUTH_APP_ENV" ADMIN_BOOTSTRAP_EMAILS)
ADMIN_AUTHZ_DATABASE_URL=$(dotenv_value "$ADMIN_APP_ENV" AUTHZ_DATABASE_URL)
ADMIN_CSRF_SECRET_VALUE=$(dotenv_value "$ADMIN_APP_ENV" ADMIN_CSRF_SECRET)
ADMIN_OIDC_CLIENT_SECRET_VALUE=$(dotenv_value "$ADMIN_APP_ENV" ADMIN_OIDC_CLIENT_SECRET)
ADMIN_ADMIN_BOOTSTRAP_EMAILS=$(dotenv_value "$ADMIN_APP_ENV" ADMIN_BOOTSTRAP_EMAILS)
[ "$AUTH_AUTHZ_DATABASE_URL" = "$ADMIN_AUTHZ_DATABASE_URL" ] || {
  echo "AUTHZ_DATABASE_URL must be identical in auth and admin application inputs." >&2
  exit 1
}
[ "$AUTH_ADMIN_BOOTSTRAP_EMAILS" = "$ADMIN_ADMIN_BOOTSTRAP_EMAILS" ] || {
  echo "ADMIN_BOOTSTRAP_EMAILS must be identical in auth and admin application inputs." >&2
  exit 1
}

if [ -e "$OUTPUT_DIR" ]; then
  [ -d "$OUTPUT_DIR" ] && [ ! -L "$OUTPUT_DIR" ] || {
    echo "Output directory must not be a symbolic link: $OUTPUT_DIR" >&2
    exit 1
  }
else
  install -d -m 700 "$OUTPUT_DIR"
fi
chmod 700 "$OUTPUT_DIR"

write_variable() {
  destination=$1
  key=$2
  value=$3
  [ -f "$destination" ] && [ ! -L "$destination" ] && [ -s "$destination" ] || {
    echo "Render GitHub variables before preparing secrets: $destination" >&2
    exit 1
  }
  [ "$(file_mode "$destination")" = 600 ] || {
    echo "Variable file must have mode 600: $destination" >&2
    exit 1
  }
  temporary=$(mktemp "$OUTPUT_DIR/.vars.env.XXXXXX")
  grep -v "^${key}=" "$destination" >"$temporary"
  printf '%s=%s\n' "$key" "$value" >>"$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$destination"
}

write_variable \
  "$OUTPUT_DIR/development-auth.vars.env" \
  ADMIN_BOOTSTRAP_EMAILS "$AUTH_ADMIN_BOOTSTRAP_EMAILS"
write_variable \
  "$OUTPUT_DIR/development-admin.vars.env" \
  ADMIN_BOOTSTRAP_EMAILS "$ADMIN_ADMIN_BOOTSTRAP_EMAILS"

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
        ;;
      admin)
        printf 'AUTHZ_DATABASE_URL=%s\n' "$ADMIN_AUTHZ_DATABASE_URL"
        printf 'ADMIN_CSRF_SECRET=%s\n' "$ADMIN_CSRF_SECRET_VALUE"
        printf 'ADMIN_OIDC_CLIENT_SECRET=%s\n' "$ADMIN_OIDC_CLIENT_SECRET_VALUE"
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
echo "Prepared development GitHub secret dotenv files in $OUTPUT_DIR. Values were not printed."
