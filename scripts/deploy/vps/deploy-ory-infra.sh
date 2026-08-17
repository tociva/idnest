#!/bin/sh
set -eu

readonly APP_ROOT=/opt/ory-auth
readonly CONFIG_ROOT=/etc/idnest
readonly INCOMING_ROOT=/var/lib/ory-auth/incoming
readonly LOCK_FILE=/var/lock/ory-auth-deploy.lock
readonly COMPOSE_FILE=$APP_ROOT/ory/compose.yaml
readonly BUILD_CONTEXT=$APP_ROOT/ory/kratos-build
readonly CONFIG_HISTORY=$APP_ROOT/ory/config-history
readonly ORY_ENV=$CONFIG_ROOT/ory.env
readonly ORY_CONFIG=$CONFIG_ROOT/ory.conf
readonly TLS_CERT_FILE=$CONFIG_ROOT/tls/origin-cert.pem
readonly TLS_KEY_FILE=$CONFIG_ROOT/tls/origin-key.pem
readonly TLS_CA_FILE=$CONFIG_ROOT/tls/origin-ca.pem
readonly VALIDATOR=/usr/local/sbin/validate-ory-app-env

fail() {
  echo "Ory deployment failed: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

root_regular_file() {
  [ -f "$1" ] && [ ! -L "$1" ] && [ "$(stat -c '%U' "$1")" = root ]
}

valid_port() {
  printf '%s\n' "$1" | grep -Eq '^[1-9][0-9]*$' && [ "$1" -le 65535 ]
}

valid_hostname() {
  printf '%s\n' "$1" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$'
}

[ "$#" -eq 1 ] || fail "usage: deploy-ory-infra GITHUB_RUN_ID"
RUN_ID=$1
printf '%s\n' "$RUN_ID" | grep -Eq '^[1-9][0-9]*$' || fail "invalid GitHub run ID"
[ "$(id -u)" -eq 0 ] || fail "deployment must run as root through the release queue processor"

for command in awk chmod chown curl diff docker find flock grep id install mv openssl rm rmdir sleep stat tar; do
  require_command "$command"
done
for file in "$COMPOSE_FILE" "$VALIDATOR" "$ORY_ENV" "$ORY_CONFIG" "$TLS_CERT_FILE" "$TLS_KEY_FILE" "$TLS_CA_FILE"; do
  root_regular_file "$file" || fail "invalid root-owned required file: $file"
done
[ -x "$VALIDATOR" ] || fail "invalid environment validator"
[ -d "$BUILD_CONTEXT/config" ] && [ ! -L "$BUILD_CONTEXT/config" ] || fail "invalid Kratos build configuration"
[ -d "$CONFIG_HISTORY" ] && [ ! -L "$CONFIG_HISTORY" ] || fail "invalid configuration history directory"
case "$(stat -c '%a' "$ORY_ENV")" in 600) ;; *) fail "Ory environment mode must be 600" ;; esac
case "$(stat -c '%a' "$ORY_CONFIG")" in 600) ;; *) fail "Ory deployment config mode must be 600" ;; esac
case "$(stat -c '%a' "$TLS_KEY_FILE")" in 440|640) ;; *) fail "TLS private key mode must be 440 or 640" ;; esac
"$VALIDATOR" "$ORY_ENV"

# shellcheck source=/dev/null
. "$ORY_CONFIG"
: "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME is required}"
: "${ORY_RUNTIME_NETWORK:?ORY_RUNTIME_NETWORK is required}"
: "${HYDRA_TLS_SERVER_NAME:?HYDRA_TLS_SERVER_NAME is required}"
: "${KRATOS_TLS_SERVER_NAME:?KRATOS_TLS_SERVER_NAME is required}"
HYDRA_ORIGIN_HTTPS_PORT=${HYDRA_ORIGIN_HTTPS_PORT:-8446}
HYDRA_ADMIN_HTTPS_PORT=${HYDRA_ADMIN_HTTPS_PORT:-4445}
KRATOS_ORIGIN_HTTPS_PORT=${KRATOS_ORIGIN_HTTPS_PORT:-8447}
KRATOS_ADMIN_HTTP_PORT=${KRATOS_ADMIN_HTTP_PORT:-4434}
valid_hostname "$HYDRA_TLS_SERVER_NAME" || fail "invalid Hydra TLS server name"
valid_hostname "$KRATOS_TLS_SERVER_NAME" || fail "invalid Kratos TLS server name"
for port in "$HYDRA_ORIGIN_HTTPS_PORT" "$HYDRA_ADMIN_HTTPS_PORT" "$KRATOS_ORIGIN_HTTPS_PORT" "$KRATOS_ADMIN_HTTP_PORT"; do
  valid_port "$port" || fail "invalid Ory port: $port"
done

openssl x509 -in "$TLS_CERT_FILE" -noout -checkend 86400 >/dev/null \
  || fail "TLS certificate is invalid or expires within 24 hours"
for hostname in "$HYDRA_TLS_SERVER_NAME" "$KRATOS_TLS_SERVER_NAME"; do
  openssl x509 -in "$TLS_CERT_FILE" -noout -checkhost "$hostname" >/dev/null \
    || fail "TLS certificate does not cover $hostname"
done
CERT_PUBLIC_KEY=$(openssl x509 -in "$TLS_CERT_FILE" -pubkey -noout)
KEY_PUBLIC_KEY=$(openssl pkey -in "$TLS_KEY_FILE" -pubout)
[ "$CERT_PUBLIC_KEY" = "$KEY_PUBLIC_KEY" ] || fail "TLS certificate and private key do not match"
TLS_READ_GID=$(stat -c '%g' "$TLS_KEY_FILE")
printf '%s\n' "$TLS_READ_GID" | grep -Eq '^[1-9][0-9]*$' \
  || fail "TLS private key must use a dedicated non-root group"

CONFIG_ARCHIVE=$INCOMING_ROOT/ory-config.tar.gz.$RUN_ID
[ -f "$CONFIG_ARCHIVE" ] && [ ! -L "$CONFIG_ARCHIVE" ] && [ -s "$CONFIG_ARCHIVE" ] \
  || fail "invalid staged Kratos configuration archive"

entries=$(tar -tzf "$CONFIG_ARCHIVE") || fail "cannot read Kratos configuration archive"
[ -n "$entries" ] || fail "Kratos configuration archive is empty"
printf '%s\n' "$entries" | while IFS= read -r entry; do
  case "/$entry/" in */../*|*/./*|*//*) fail "unsafe archive path: $entry" ;; esac
  case "$entry" in config/kratos.tpl.yml|config/kratos/*) ;; *) fail "unexpected archive path: $entry" ;; esac
done
tar -tvzf "$CONFIG_ARCHIVE" | awk '$1 !~ /^-/ { exit 1 }' || fail "archive may contain only regular files"
printf '%s\n' "$entries" | grep -Fx 'config/kratos.tpl.yml' >/dev/null || fail "archive is missing kratos.tpl.yml"
printf '%s\n' "$entries" | grep -Fx 'config/kratos/identity.schema.json' >/dev/null || fail "archive is missing identity schema"

exec 8>"$LOCK_FILE"
flock -n 8 || fail "another auth/admin deployment is running"

STAGE_ROOT=$APP_ROOT/ory/config-stage.$RUN_ID
BACKUP_ROOT=$CONFIG_HISTORY/$RUN_ID
CONFIG_SWAPPED=false
DEPLOYMENT_SUCCEEDED=false

ORY_ENV_FILE=$ORY_ENV
export COMPOSE_PROJECT_NAME ORY_RUNTIME_NETWORK HYDRA_TLS_SERVER_NAME KRATOS_TLS_SERVER_NAME ORY_ENV_FILE
export HYDRA_ORIGIN_HTTPS_PORT HYDRA_ADMIN_HTTPS_PORT KRATOS_ORIGIN_HTTPS_PORT KRATOS_ADMIN_HTTP_PORT
export TLS_CERT_FILE TLS_KEY_FILE TLS_READ_GID

compose() {
  docker compose --project-name "$COMPOSE_PROJECT_NAME" --file "$COMPOSE_FILE" "$@"
}

restore_on_failure() {
  rm -f -- "$CONFIG_ARCHIVE"
  if [ "$DEPLOYMENT_SUCCEEDED" != true ] && [ "$CONFIG_SWAPPED" = true ]; then
    failed_root=$APP_ROOT/ory/config-failed.$RUN_ID.$$
    mv "$BUILD_CONTEXT/config" "$failed_root" 2>/dev/null || true
    mv "$BACKUP_ROOT" "$BUILD_CONTEXT/config" 2>/dev/null || true
    compose up --detach --build --force-recreate >/dev/null 2>&1 || true
    echo "Ory configuration was restored after a failed deployment." >&2
  fi
  [ ! -e "$STAGE_ROOT" ] || rm -rf -- "$STAGE_ROOT"
}
trap restore_on_failure EXIT

[ ! -e "$STAGE_ROOT" ] || fail "staging directory already exists"
[ ! -e "$BACKUP_ROOT" ] || fail "configuration history already exists for this run"
install -d -o root -g root -m 700 "$STAGE_ROOT"
tar -xzf "$CONFIG_ARCHIVE" --directory "$STAGE_ROOT" --no-same-owner --no-same-permissions
find "$STAGE_ROOT" -type l -print -quit | grep -q . && fail "configuration archive contains a symbolic link"
find "$STAGE_ROOT" -type d -exec chmod 755 {} +
find "$STAGE_ROOT" -type f -exec chmod 644 {} +
chown -R root:root "$STAGE_ROOT"
rm -f -- "$CONFIG_ARCHIVE"

mv "$BUILD_CONTEXT/config" "$BACKUP_ROOT"
mv "$STAGE_ROOT/config" "$BUILD_CONTEXT/config"
rmdir "$STAGE_ROOT"
CONFIG_SWAPPED=true

docker run --rm --env-file "$ORY_ENV" --add-host host.docker.internal:host-gateway \
  --entrypoint sh oryd/hydra:v26.2.0 -c \
  'export DSN="$HYDRA_DSN"; exec hydra migrate sql up -e --yes'
docker run --rm --env-file "$ORY_ENV" --add-host host.docker.internal:host-gateway \
  --entrypoint sh oryd/kratos:v26.2.0 -c \
  'export DSN="$KRATOS_DSN"; exec kratos migrate sql -e --yes'

compose config --quiet || fail "Ory Compose configuration is invalid"
compose build --pull kratos
compose up --detach --force-recreate

attempts=0
until curl --fail --silent --show-error --cacert "$TLS_CA_FILE" --noproxy '*' \
  --resolve "$HYDRA_TLS_SERVER_NAME:$HYDRA_ADMIN_HTTPS_PORT:127.0.0.1" \
  "https://$HYDRA_TLS_SERVER_NAME:$HYDRA_ADMIN_HTTPS_PORT/health/ready" >/dev/null; do
  attempts=$((attempts + 1))
  [ "$attempts" -lt 60 ] || fail "Hydra did not become ready over HTTPS"
  sleep 2
done

attempts=0
until curl --fail --silent --show-error --cacert "$TLS_CA_FILE" --noproxy '*' \
  --resolve "$KRATOS_TLS_SERVER_NAME:$KRATOS_ORIGIN_HTTPS_PORT:127.0.0.1" \
  "https://$KRATOS_TLS_SERVER_NAME:$KRATOS_ORIGIN_HTTPS_PORT/health/ready" >/dev/null; do
  attempts=$((attempts + 1))
  [ "$attempts" -lt 60 ] || fail "Kratos did not become ready over HTTPS"
  sleep 2
done

DEPLOYMENT_SUCCEEDED=true
echo "Hydra and Kratos are ready with direct TLS configuration from GitHub run $RUN_ID."
