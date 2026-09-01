#!/bin/sh
set -eu

readonly APP_ROOT=/opt/idnest
readonly CONFIG_ROOT=/etc/idnest
readonly INCOMING_ROOT=/var/lib/idnest/incoming
readonly LOCK_FILE=/var/lock/idnest-deploy.lock
readonly ENV_VALIDATOR=/usr/local/sbin/validate-idnest-app-env
readonly CLOUDFLARED_READY_URL=http://127.0.0.1:20242/ready

fail() {
  echo "Deployment failed: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

root_regular_file() {
  [ -f "$1" ] && [ ! -L "$1" ] && [ "$(stat -c '%U' "$1")" = root ]
}

valid_image() {
  printf '%s\n' "$1" | grep -Eq '^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$'
}

valid_revision() {
  printf '%s\n' "$1" | grep -Eq '^[a-f0-9]{40}$'
}

valid_positive_integer() {
  printf '%s\n' "$1" | grep -Eq '^[1-9][0-9]*$'
}

valid_port() {
  valid_positive_integer "$1" && [ "$1" -le 65535 ]
}

write_release_env() {
  image=$1
  revision=$2
  destination=$3
  umask 077
  {
    printf 'COMPOSE_PROJECT_NAME=%s\n' "$COMPOSE_PROJECT_NAME"
    printf 'RUNTIME_NETWORK=%s\n' "$RUNTIME_NETWORK"
    printf '%s=%s\n' "$HTTP_PORT_VARIABLE" "$HTTP_PORT"
    printf 'APP_MEMORY_LIMIT=%s\n' "$APP_MEMORY_LIMIT"
    printf 'APP_CPU_LIMIT=%s\n' "$APP_CPU_LIMIT"
    printf 'APP_IMAGE=%s\n' "$image"
    printf 'APP_REVISION=%s\n' "$revision"
    printf 'APP_ENV_FILE=%s\n' "$APP_ENV"
  } >"$destination"
}

compose() {
  docker compose \
    --project-name "$COMPOSE_PROJECT_NAME" \
    --file "$COMPOSE_FILE" \
    --env-file "$RELEASE_ENV" \
    "$@"
}

wait_until_healthy() {
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECONDS ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    container_id=$(compose ps --quiet "$SERVICE_NAME")
    if [ -n "$container_id" ]; then
      status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")
      case "$status" in
        healthy) return 0 ;;
        exited|dead)
          compose logs --no-color --tail 100 "$SERVICE_NAME" >&2 || true
          return 1
          ;;
      esac
    fi
    sleep 2
  done
  compose logs --no-color --tail 100 "$SERVICE_NAME" >&2 || true
  return 1
}

host_local_ready() {
  curl --fail --silent --show-error --noproxy '*' \
    "http://127.0.0.1:$HTTP_PORT/health" >/dev/null
}

tunnel_ready() {
  curl --fail --silent --show-error --noproxy '*' "$CLOUDFLARED_READY_URL" >/dev/null
}

restore_release_metadata() {
  if [ -n "$ACTIVE_IMAGE" ]; then
    write_release_env "$ACTIVE_IMAGE" "$ACTIVE_REVISION" "$RELEASE_ENV.restore"
    mv "$RELEASE_ENV.restore" "$RELEASE_ENV"
  else
    rm -f -- "$RELEASE_ENV"
  fi
}

restore_previous_release() {
  if [ -z "$ACTIVE_IMAGE" ]; then
    echo "No previous release exists; removing the failed first-deployment container." >&2
    compose rm --force --stop "$SERVICE_NAME" >&2 || return 1
    restore_application_env
    restore_release_metadata
    return 0
  fi
  echo "Restoring previous image $ACTIVE_IMAGE" >&2
  restore_application_env
  restore_release_metadata
  compose up --detach --no-deps "$SERVICE_NAME" >&2 || return 1
  wait_until_healthy && host_local_ready
}

restore_application_env() {
  [ "${APP_ENV_INSTALLED:-false}" = true ] || return 0
  if [ "${APP_ENV_PREVIOUSLY_PRESENT:-false}" = true ]; then
    mv -- "$APP_ENV_BACKUP" "$APP_ENV"
  else
    rm -f -- "$APP_ENV"
  fi
  APP_ENV_INSTALLED=false
}

cleanup() {
  if [ "${DEPLOYMENT_SUCCEEDED:-false}" != true ]; then
    if [ "${CANDIDATE_STARTED:-false}" = true ]; then
      CANDIDATE_STARTED=false
      restore_previous_release || true
    else
      restore_application_env || true
    fi
  fi
  [ -z "${STATE_CANDIDATE:-}" ] || rm -f -- "$STATE_CANDIDATE"
  rm -f -- "$RELEASE_ENV.candidate" "$RELEASE_ENV.restore"
  [ -z "${APP_ENV_BACKUP:-}" ] || rm -f -- "$APP_ENV_BACKUP"
  [ -z "${REGISTRY:-}" ] || docker logout "$REGISTRY" >/dev/null 2>&1 || true
}

[ "$#" -eq 4 ] || fail "usage: deploy-idnest-app KIND IMAGE@DIGEST GIT_REVISION GITHUB_RUN_ID"
KIND=$1
IMAGE_REF=$2
REVISION=$3
RUN_ID=$4

case "$KIND" in
  auth)
    SERVICE_NAME=auth
    COMPOSE_FILE=$APP_ROOT/auth/compose.yaml
    DEPLOY_CONFIG=$CONFIG_ROOT/auth.conf
    APP_ENV=$CONFIG_ROOT/auth-app.env
    HTTP_PORT_VARIABLE=AUTH_HTTP_PORT
    DEFAULT_HTTP_PORT=8444
    ;;
  admin)
    SERVICE_NAME='admin'
    COMPOSE_FILE=$APP_ROOT/admin/compose.yaml
    DEPLOY_CONFIG=$CONFIG_ROOT/admin.conf
    APP_ENV=$CONFIG_ROOT/admin-app.env
    HTTP_PORT_VARIABLE=ADMIN_HTTP_PORT
    DEFAULT_HTTP_PORT=8445
    ;;
  *) fail "kind must be auth or admin" ;;
esac

KIND_ROOT=$APP_ROOT/$KIND
RELEASE_ENV=$KIND_ROOT/release.env
STATE_FILE=$KIND_ROOT/state.env
HISTORY_ROOT=$KIND_ROOT/deployment-history
ECR_PASSWORD=$INCOMING_ROOT/ecr-password.$RUN_ID
APP_ENV_CANDIDATE=$INCOMING_ROOT/$KIND-app.env.$RUN_ID
APP_ENV_BACKUP=$KIND_ROOT/app.env.before.$RUN_ID
APP_ENV_CANDIDATE_PRESENT=false
STATE_CANDIDATE=
REGISTRY=
APP_ENV_INSTALLED=false
APP_ENV_PREVIOUSLY_PRESENT=false
CANDIDATE_STARTED=false
DEPLOYMENT_SUCCEEDED=false
trap cleanup EXIT

valid_image "$IMAGE_REF" || fail "image must be an ECR URI pinned by sha256 digest"
valid_revision "$REVISION" || fail "revision must be a full lowercase Git SHA"
valid_positive_integer "$RUN_ID" || fail "GitHub run ID must be a positive integer"

for command in chmod cp curl date docker flock grep id install mkdir mv rm sha256sum sleep stat; do
  require_command "$command"
done
docker compose version >/dev/null 2>&1 || fail "Docker Compose plugin is unavailable"
[ "$(id -u)" -eq 0 ] || fail "deployment must run as root through the release queue processor"
for file in "$COMPOSE_FILE" "$DEPLOY_CONFIG" "$ENV_VALIDATOR" "$ECR_PASSWORD"; do
  root_regular_file "$file" || fail "invalid root-owned deployment file: $file"
done
[ -x "$ENV_VALIDATOR" ] || fail "environment validator is not executable"
case "$(stat -c '%a' "$DEPLOY_CONFIG")" in 600) ;; *) fail "deployment config mode must be 600" ;; esac
if [ -e "$APP_ENV_CANDIDATE" ] || [ -L "$APP_ENV_CANDIDATE" ]; then
  root_regular_file "$APP_ENV_CANDIDATE" || fail "invalid root-owned staged application environment"
  case "$(stat -c '%a' "$APP_ENV_CANDIDATE")" in 600) ;; *) fail "staged application environment mode must be 600" ;; esac
  APP_ENV_CANDIDATE_PRESENT=true
fi

# shellcheck source=/dev/null
. "$DEPLOY_CONFIG"
: "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME is required}"
: "${RUNTIME_NETWORK:?RUNTIME_NETWORK is required}"
: "${PUBLIC_HEALTH_URL:?PUBLIC_HEALTH_URL is required}"
eval "HTTP_PORT=\${$HTTP_PORT_VARIABLE:-$DEFAULT_HTTP_PORT}"
HEALTH_TIMEOUT_SECONDS=${HEALTH_TIMEOUT_SECONDS:-120}
REQUIRE_BACKUP_HOOK=${REQUIRE_BACKUP_HOOK:-true}
APP_MEMORY_LIMIT=${APP_MEMORY_LIMIT:-768m}
APP_CPU_LIMIT=${APP_CPU_LIMIT:-1.0}

valid_port "$HTTP_PORT" || fail "invalid private-origin HTTP port"
valid_positive_integer "$HEALTH_TIMEOUT_SECONDS" || fail "invalid health timeout"
case "$PUBLIC_HEALTH_URL" in https://*) ;; *) fail "public health URL must use HTTPS" ;; esac
case "$REQUIRE_BACKUP_HOOK" in true|false) ;; *) fail "invalid backup-hook setting" ;; esac

if [ "$APP_ENV_CANDIDATE_PRESENT" = true ]; then
  "$ENV_VALIDATOR" "$APP_ENV_CANDIDATE" "$KIND"
elif root_regular_file "$APP_ENV"; then
  case "$(stat -c '%a' "$APP_ENV")" in 600) ;; *) fail "existing application environment mode must be 600" ;; esac
  "$ENV_VALIDATOR" "$APP_ENV" "$KIND"
else
  fail "host-only deployment requires an existing root-owned application environment: $APP_ENV"
fi
if [ -e "$APP_ENV" ] || [ -L "$APP_ENV" ]; then
  root_regular_file "$APP_ENV" || fail "existing application environment must be a root-owned regular file"
  case "$(stat -c '%a' "$APP_ENV")" in 600) ;; *) fail "existing application environment mode must be 600" ;; esac
fi
tunnel_ready || fail "Cloudflare Tunnel connector is not ready"

exec 9>"$LOCK_FILE"
flock -n 9 || fail "another auth/admin deployment is running"
mkdir -p "$HISTORY_ROOT"

app_env_install_candidate=$APP_ENV.candidate.$RUN_ID
if [ "$APP_ENV_CANDIDATE_PRESENT" = true ]; then
  [ ! -e "$APP_ENV_BACKUP" ] && [ ! -L "$APP_ENV_BACKUP" ] \
    || fail "application environment backup path already exists"
  if [ -f "$APP_ENV" ]; then
    cp -p -- "$APP_ENV" "$APP_ENV_BACKUP"
    APP_ENV_PREVIOUSLY_PRESENT=true
  fi
  [ ! -e "$app_env_install_candidate" ] && [ ! -L "$app_env_install_candidate" ] \
    || fail "application environment candidate path already exists"
  install -o root -g root -m 600 "$APP_ENV_CANDIDATE" "$app_env_install_candidate"
  mv -- "$app_env_install_candidate" "$APP_ENV"
  rm -f -- "$APP_ENV_CANDIDATE"
  APP_ENV_INSTALLED=true
fi

ACTIVE_IMAGE=
ACTIVE_REVISION=
if [ -f "$STATE_FILE" ]; then
  root_regular_file "$STATE_FILE" || fail "invalid deployment state"
  # shellcheck source=/dev/null
  . "$STATE_FILE"
  valid_image "$ACTIVE_IMAGE" || fail "invalid active image in state"
  valid_revision "$ACTIVE_REVISION" || fail "invalid active revision in state"
fi

write_release_env "$IMAGE_REF" "$REVISION" "$RELEASE_ENV.candidate"
mv "$RELEASE_ENV.candidate" "$RELEASE_ENV"
compose config --quiet || { restore_application_env; restore_release_metadata; fail "Compose configuration is invalid"; }

REGISTRY=${IMAGE_REF%%/*}
docker login --username AWS --password-stdin "$REGISTRY" <"$ECR_PASSWORD" >/dev/null \
  || { restore_application_env; restore_release_metadata; fail "ECR login failed"; }
compose pull "$SERVICE_NAME" || { restore_application_env; restore_release_metadata; fail "candidate image pull failed"; }

backup_hook=$CONFIG_ROOT/pre-deploy-backup
if [ -e "$backup_hook" ] || [ -L "$backup_hook" ]; then
  root_regular_file "$backup_hook" && [ -x "$backup_hook" ] \
    || { restore_application_env; restore_release_metadata; fail "$backup_hook must be a root-owned executable regular file"; }
  "$backup_hook" "$KIND" "$REVISION" \
    || { restore_application_env; restore_release_metadata; fail "pre-deployment backup failed"; }
elif [ "$REQUIRE_BACKUP_HOOK" = true ]; then
  restore_application_env
  restore_release_metadata
  fail "$backup_hook is required but missing"
fi

compose run --rm --no-deps "$SERVICE_NAME" node migrations/authz-migrate.cjs \
  || { restore_application_env; restore_release_metadata; fail "database migration failed"; }

if ! compose up --detach --no-deps "$SERVICE_NAME"; then
  restore_previous_release || true
  CANDIDATE_STARTED=false
  fail "candidate failed to start"
fi
CANDIDATE_STARTED=true
if ! wait_until_healthy || ! host_local_ready || ! tunnel_ready; then
  restore_previous_release || true
  CANDIDATE_STARTED=false
  fail "candidate failed its container, loopback HTTP, or Tunnel readiness check"
fi

if ! curl --fail --silent --show-error --retry 5 --retry-delay 3 \
  --header 'Cache-Control: no-cache' "$PUBLIC_HEALTH_URL" >/dev/null; then
  restore_previous_release || true
  CANDIDATE_STARTED=false
  fail "candidate failed the public Cloudflare readiness check"
fi

DEPLOYED_AT=$(date -u '+%Y%m%dT%H%M%SZ')
CONFIG_SHA256=$(sha256sum "$APP_ENV" | awk '{print $1}')
STATE_CANDIDATE=$STATE_FILE.$RUN_ID.tmp
umask 077
{
  printf 'ACTIVE_IMAGE=%s\n' "$IMAGE_REF"
  printf 'ACTIVE_REVISION=%s\n' "$REVISION"
  printf 'PREVIOUS_IMAGE=%s\n' "$ACTIVE_IMAGE"
  printf 'PREVIOUS_REVISION=%s\n' "$ACTIVE_REVISION"
  printf 'DEPLOYED_AT=%s\n' "$DEPLOYED_AT"
  printf 'GITHUB_RUN_ID=%s\n' "$RUN_ID"
  printf 'CONFIG_SHA256=%s\n' "$CONFIG_SHA256"
} >"$STATE_CANDIDATE"
mv "$STATE_CANDIDATE" "$STATE_FILE"
STATE_CANDIDATE=
cp "$STATE_FILE" "$HISTORY_ROOT/$DEPLOYED_AT-$RUN_ID.env"
chmod 600 "$HISTORY_ROOT/$DEPLOYED_AT-$RUN_ID.env"
rm -f -- "$APP_ENV_BACKUP"
APP_ENV_INSTALLED=false
CANDIDATE_STARTED=false
DEPLOYMENT_SUCCEEDED=true
docker logout "$REGISTRY" >/dev/null 2>&1 || true
REGISTRY=
echo "Deployment complete: $KIND runs $IMAGE_REF on loopback HTTP port $HTTP_PORT"
