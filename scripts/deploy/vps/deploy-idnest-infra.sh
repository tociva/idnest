#!/bin/sh
set -eu

readonly APP_ROOT=/opt/idnest
readonly CONFIG_ROOT=/etc/idnest
readonly INCOMING_ROOT=/var/lib/idnest/incoming
readonly LOCK_FILE=/var/lock/idnest-deploy.lock
readonly COMPOSE_FILE=$APP_ROOT/identity/compose.yaml
readonly BUILD_CONTEXT=$APP_ROOT/identity/kratos-build
readonly CONFIG_HISTORY=$APP_ROOT/identity/config-history
readonly STATE_FILE=$APP_ROOT/identity/state.env
readonly IDNEST_ENV=$CONFIG_ROOT/idnest.env
readonly IDNEST_CONFIG=$CONFIG_ROOT/idnest.conf
readonly VALIDATOR=/usr/local/sbin/validate-idnest-app-env
readonly CLOUDFLARED_READY_URL=http://127.0.0.1:20242/ready

fail() {
  echo "Idnest identity deployment failed: $*" >&2
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

[ "$#" -eq 3 ] || fail "usage: deploy-idnest-infra GITHUB_RUN_ID REQUEST_ID GIT_REVISION"
RUN_ID=$1
REQUEST_ID=$2
REVISION=$3
printf '%s\n' "$RUN_ID" | grep -Eq '^[1-9][0-9]*$' || fail "invalid GitHub run ID"
printf '%s\n' "$REQUEST_ID" | grep -Eq '^[1-9][0-9]*-[1-9][0-9]*$' || fail "invalid release request ID"
printf '%s\n' "$REVISION" | grep -Eq '^[a-f0-9]{40}$' || fail "invalid Git revision"
[ "$(id -u)" -eq 0 ] || fail "deployment must run as root through the release queue processor"

for command in awk chmod chown cp curl docker find flock grep id install mv rm rmdir sha256sum sleep stat tar; do
  require_command "$command"
done
docker compose version >/dev/null 2>&1 || fail "Docker Compose plugin is unavailable"
for file in "$COMPOSE_FILE" "$VALIDATOR" "$IDNEST_CONFIG"; do
  root_regular_file "$file" || fail "invalid root-owned required file: $file"
done
[ -x "$VALIDATOR" ] || fail "invalid environment validator"
if ! {
  [ -d "$BUILD_CONTEXT/config" ] &&
    [ ! -L "$BUILD_CONTEXT/config" ]
}; then
  fail "invalid Kratos build configuration"
fi
if ! {
  [ -d "$CONFIG_HISTORY" ] &&
    [ ! -L "$CONFIG_HISTORY" ]
}; then
  fail "invalid configuration history directory"
fi
case "$(stat -c '%a' "$IDNEST_CONFIG")" in 600) ;; *) fail "Idnest deployment config mode must be 600" ;; esac

IDNEST_ENV_CANDIDATE=$INCOMING_ROOT/idnest.env.$RUN_ID
CONFIG_ARCHIVE=$INCOMING_ROOT/idnest-config.tar.gz.$RUN_ID
root_regular_file "$IDNEST_ENV_CANDIDATE" || fail "invalid staged Idnest environment"
[ -s "$IDNEST_ENV_CANDIDATE" ] || fail "staged Idnest environment is empty"
case "$(stat -c '%a' "$IDNEST_ENV_CANDIDATE")" in 600) ;; *) fail "staged Idnest environment mode must be 600" ;; esac
if ! {
  root_regular_file "$CONFIG_ARCHIVE" &&
    [ -s "$CONFIG_ARCHIVE" ]
}; then
  fail "invalid staged Kratos configuration archive"
fi
"$VALIDATOR" "$IDNEST_ENV_CANDIDATE" identity >/dev/null

if [ -e "$IDNEST_ENV" ] || [ -L "$IDNEST_ENV" ]; then
  root_regular_file "$IDNEST_ENV" || fail "existing Idnest environment must be a root-owned regular file"
  case "$(stat -c '%a' "$IDNEST_ENV")" in 600) ;; *) fail "existing Idnest environment mode must be 600" ;; esac
fi

# shellcheck source=/dev/null
. "$IDNEST_CONFIG"
: "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME is required}"
: "${IDNEST_RUNTIME_NETWORK:?IDNEST_RUNTIME_NETWORK is required}"
: "${HYDRA_PUBLIC_HEALTH_URL:?HYDRA_PUBLIC_HEALTH_URL is required}"
: "${KRATOS_PUBLIC_HEALTH_URL:?KRATOS_PUBLIC_HEALTH_URL is required}"
HYDRA_PUBLIC_HTTP_PORT=${HYDRA_PUBLIC_HTTP_PORT:-8446}
HYDRA_ADMIN_HTTP_PORT=${HYDRA_ADMIN_HTTP_PORT:-4445}
KRATOS_PUBLIC_HTTP_PORT=${KRATOS_PUBLIC_HTTP_PORT:-8447}
KRATOS_ADMIN_HTTP_PORT=${KRATOS_ADMIN_HTTP_PORT:-4434}
for port in "$HYDRA_PUBLIC_HTTP_PORT" "$HYDRA_ADMIN_HTTP_PORT" "$KRATOS_PUBLIC_HTTP_PORT" "$KRATOS_ADMIN_HTTP_PORT"; do
  valid_port "$port" || fail "invalid identity service port: $port"
done
case "$HYDRA_PUBLIC_HEALTH_URL" in https://*) ;; *) fail "Hydra public health URL must use HTTPS" ;; esac
case "$KRATOS_PUBLIC_HEALTH_URL" in https://*) ;; *) fail "Kratos public health URL must use HTTPS" ;; esac
curl --fail --silent --show-error --noproxy '*' "$CLOUDFLARED_READY_URL" >/dev/null \
  || fail "Cloudflare Tunnel connector is not ready"

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
flock -n 8 || fail "another Idnest deployment is running"

STAGE_ROOT=$APP_ROOT/identity/config-stage.$REQUEST_ID
BACKUP_ROOT=$CONFIG_HISTORY/$REQUEST_ID
ENV_BACKUP=$APP_ROOT/identity/idnest.env.before.$REQUEST_ID
ENV_INSTALL_CANDIDATE=$IDNEST_ENV.candidate.$REQUEST_ID
CONFIG_SWAPPED=false
ENV_INSTALLED=false
ENV_PREVIOUSLY_PRESENT=false
DEPLOYMENT_SUCCEEDED=false
IDENTITY_ENV_SHA256=$(sha256sum "$IDNEST_ENV_CANDIDATE" | awk '{print $1}')
IDENTITY_CONFIG_SHA256=$(sha256sum "$CONFIG_ARCHIVE" | awk '{print $1}')

IDNEST_ENV_FILE=$IDNEST_ENV
export COMPOSE_PROJECT_NAME IDNEST_RUNTIME_NETWORK IDNEST_ENV_FILE
export HYDRA_PUBLIC_HTTP_PORT HYDRA_ADMIN_HTTP_PORT KRATOS_PUBLIC_HTTP_PORT KRATOS_ADMIN_HTTP_PORT

compose() {
  docker compose --project-name "$COMPOSE_PROJECT_NAME" --file "$COMPOSE_FILE" "$@"
}

restore_on_failure() {
  exit_code=$?
  rm -f -- "$IDNEST_ENV_CANDIDATE" "$CONFIG_ARCHIVE" "$ENV_INSTALL_CANDIDATE" "$STATE_FILE.candidate"
  if [ "$DEPLOYMENT_SUCCEEDED" != true ]; then
    if [ "$CONFIG_SWAPPED" = true ]; then
      failed_root=$APP_ROOT/identity/config-failed.$REQUEST_ID.$$
      mv "$BUILD_CONTEXT/config" "$failed_root" 2>/dev/null || true
      mv "$BACKUP_ROOT" "$BUILD_CONTEXT/config" 2>/dev/null || true
      rm -rf -- "$failed_root"
      CONFIG_SWAPPED=false
    fi
    if [ "$ENV_INSTALLED" = true ]; then
      if [ "$ENV_PREVIOUSLY_PRESENT" = true ]; then
        mv -- "$ENV_BACKUP" "$IDNEST_ENV" 2>/dev/null || true
      else
        rm -f -- "$IDNEST_ENV"
      fi
      ENV_INSTALLED=false
    fi
    if [ "$ENV_PREVIOUSLY_PRESENT" = true ]; then
      compose build kratos >/dev/null 2>&1 || true
      compose up --detach --force-recreate >/dev/null 2>&1 || true
      echo "Previous Idnest identity environment and configuration were restored." >&2
    else
      compose down --remove-orphans >/dev/null 2>&1 || true
      echo "Failed first identity deployment was removed; no previous environment existed." >&2
    fi
  fi
  [ ! -e "$STAGE_ROOT" ] || rm -rf -- "$STAGE_ROOT"
  rm -f -- "$ENV_BACKUP"
  return "$exit_code"
}
trap restore_on_failure EXIT
trap 'exit 1' HUP INT TERM

[ ! -e "$STAGE_ROOT" ] || fail "staging directory already exists"
[ ! -e "$BACKUP_ROOT" ] || fail "configuration history already exists for this run"
if ! {
  [ ! -e "$ENV_BACKUP" ] &&
    [ ! -L "$ENV_BACKUP" ]
}; then
  fail "identity environment backup already exists for this run"
fi
if ! {
  [ ! -e "$ENV_INSTALL_CANDIDATE" ] &&
    [ ! -L "$ENV_INSTALL_CANDIDATE" ]
}; then
  fail "identity environment install candidate already exists"
fi

install -d -o root -g root -m 700 "$STAGE_ROOT"
tar -xzf "$CONFIG_ARCHIVE" --directory "$STAGE_ROOT" --no-same-owner --no-same-permissions
find "$STAGE_ROOT" -type l -print -quit | grep -q . && fail "configuration archive contains a symbolic link"
find "$STAGE_ROOT" -type d -exec chmod 755 {} +
find "$STAGE_ROOT" -type f -exec chmod 644 {} +
chown -R root:root "$STAGE_ROOT"

if [ -f "$IDNEST_ENV" ]; then
  cp -p -- "$IDNEST_ENV" "$ENV_BACKUP"
  ENV_PREVIOUSLY_PRESENT=true
fi
install -o root -g root -m 600 "$IDNEST_ENV_CANDIDATE" "$ENV_INSTALL_CANDIDATE"
mv -- "$ENV_INSTALL_CANDIDATE" "$IDNEST_ENV"
rm -f -- "$IDNEST_ENV_CANDIDATE"
ENV_INSTALLED=true

mv "$BUILD_CONTEXT/config" "$BACKUP_ROOT"
CONFIG_SWAPPED=true
mv "$STAGE_ROOT/config" "$BUILD_CONTEXT/config"
rmdir "$STAGE_ROOT"
rm -f -- "$CONFIG_ARCHIVE"

compose config --quiet || fail "Idnest identity Compose configuration is invalid"
compose build --pull kratos

# These one-off containers use the exact candidate env_file, host mapping, and
# Docker network used by the running services. Successful migrations therefore
# prove that both DSNs are reachable from Docker before services are replaced.
compose run --rm --no-deps --entrypoint sh hydra -c \
  "export DSN=\"\$HYDRA_DSN\"; exec hydra migrate sql up -e --yes"
compose run --rm --no-deps --entrypoint sh kratos -c \
  "export DSN=\"\$KRATOS_DSN\"; exec kratos migrate sql -e --yes"

compose up --detach --force-recreate

attempts=0
until curl --fail --silent --show-error --noproxy '*' \
  "http://127.0.0.1:$HYDRA_ADMIN_HTTP_PORT/health/ready" >/dev/null; do
  attempts=$((attempts + 1))
  [ "$attempts" -lt 60 ] || fail "Hydra did not become ready over loopback HTTP"
  sleep 2
done

attempts=0
until curl --fail --silent --show-error --noproxy '*' \
  "http://127.0.0.1:$KRATOS_PUBLIC_HTTP_PORT/health/ready" >/dev/null; do
  attempts=$((attempts + 1))
  [ "$attempts" -lt 60 ] || fail "Kratos did not become ready over loopback HTTP"
  sleep 2
done

curl --fail --silent --show-error --noproxy '*' "$CLOUDFLARED_READY_URL" >/dev/null \
  || fail "Cloudflare Tunnel connector lost readiness"
curl --fail --silent --show-error --retry 8 --retry-delay 3 "$HYDRA_PUBLIC_HEALTH_URL" >/dev/null \
  || fail "Hydra failed public Cloudflare readiness"
curl --fail --silent --show-error --retry 8 --retry-delay 3 "$KRATOS_PUBLIC_HEALTH_URL" >/dev/null \
  || fail "Kratos failed public Cloudflare readiness"

umask 077
{
  printf 'GIT_REVISION=%s\n' "$REVISION"
  printf 'GITHUB_RUN_ID=%s\n' "$RUN_ID"
  printf 'REQUEST_ID=%s\n' "$REQUEST_ID"
  printf 'IDENTITY_ENV_SHA256=%s\n' "$IDENTITY_ENV_SHA256"
  printf 'IDENTITY_CONFIG_SHA256=%s\n' "$IDENTITY_CONFIG_SHA256"
} >"$STATE_FILE.candidate"
mv -- "$STATE_FILE.candidate" "$STATE_FILE"
rm -f -- "$ENV_BACKUP"
DEPLOYMENT_SUCCEEDED=true
echo "Hydra and Kratos are ready with signed configuration from GitHub run $RUN_ID."
