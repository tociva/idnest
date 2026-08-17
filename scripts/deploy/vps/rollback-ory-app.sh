#!/bin/sh
set -eu

readonly APP_ROOT=/opt/ory-auth
readonly CONFIG_ROOT=/etc/idnest
readonly LOCK_FILE=/var/lock/ory-auth-deploy.lock
readonly TLS_CERT_FILE=$CONFIG_ROOT/tls/origin-cert.pem
readonly TLS_KEY_FILE=$CONFIG_ROOT/tls/origin-key.pem
readonly TLS_CA_FILE=$CONFIG_ROOT/tls/origin-ca.pem

fail() {
  echo "Rollback failed: $*" >&2
  exit 1
}

valid_image() {
  printf '%s\n' "$1" | grep -Eq '^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$'
}

valid_revision() {
  printf '%s\n' "$1" | grep -Eq '^[a-f0-9]{40}$'
}

dotenv_value() {
  awk -v wanted="$1" '
    /^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/ {
      key=$0; sub(/^[[:space:]]*/, "", key); sub(/[[:space:]]*=.*/, "", key)
      if (key == wanted) {
        value=$0; sub(/^[^=]*=/, "", value); sub(/^[[:space:]]*/, "", value); sub(/[[:space:]]*$/, "", value)
        if (value ~ /^".*"$/ || value ~ /^\047.*\047$/) value=substr(value, 2, length(value)-2)
        print value; exit
      }
    }
  ' "$APP_ENV"
}

[ "$#" -eq 1 ] || fail "usage: rollback-ory-app KIND"
KIND=$1
case "$KIND" in
  auth)
    SERVICE_NAME=auth
    APP_ENV=$CONFIG_ROOT/auth-app.env
    DEFAULT_ORIGIN_HTTPS_PORT=8444
    ;;
  admin)
    SERVICE_NAME=admin
    APP_ENV=$CONFIG_ROOT/admin-app.env
    DEFAULT_ORIGIN_HTTPS_PORT=8445
    ;;
  *) fail "kind must be auth or admin" ;;
esac

KIND_ROOT=$APP_ROOT/$KIND
COMPOSE_FILE=$KIND_ROOT/compose.yaml
RELEASE_ENV=$KIND_ROOT/release.env
STATE_FILE=$KIND_ROOT/state.env
DEPLOY_CONFIG=$CONFIG_ROOT/$KIND.conf

[ "$(id -u)" -eq 0 ] || fail "rollback must run through sudo as root"
for file in "$COMPOSE_FILE" "$RELEASE_ENV" "$STATE_FILE" "$DEPLOY_CONFIG" "$APP_ENV" "$TLS_CERT_FILE" "$TLS_KEY_FILE" "$TLS_CA_FILE"; do
  [ -f "$file" ] && [ ! -L "$file" ] && [ "$(stat -c '%U' "$file")" = root ] \
    || fail "invalid root-owned required file: $file"
done

# shellcheck source=/dev/null
. "$DEPLOY_CONFIG"
# shellcheck source=/dev/null
. "$STATE_FILE"
: "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME is required}"
: "${RUNTIME_NETWORK:?RUNTIME_NETWORK is required}"
: "${PUBLIC_HEALTH_URL:?PUBLIC_HEALTH_URL is required}"
ORIGIN_HTTPS_PORT=${ORIGIN_HTTPS_PORT:-$DEFAULT_ORIGIN_HTTPS_PORT}
HEALTH_TIMEOUT_SECONDS=${HEALTH_TIMEOUT_SECONDS:-120}
APP_MEMORY_LIMIT=${APP_MEMORY_LIMIT:-768m}
APP_CPU_LIMIT=${APP_CPU_LIMIT:-1.0}
[ -n "${PREVIOUS_IMAGE:-}" ] && valid_image "$PREVIOUS_IMAGE" || fail "there is no valid previous image to restore"
[ -n "${PREVIOUS_REVISION:-}" ] && valid_revision "$PREVIOUS_REVISION" || fail "there is no valid previous revision to restore"
valid_image "$ACTIVE_IMAGE" || fail "active image state is invalid"
valid_revision "$ACTIVE_REVISION" || fail "active revision state is invalid"

TLS_SERVER_NAME=$(dotenv_value TLS_SERVER_NAME)
TLS_READ_GID=$(stat -c '%g' "$TLS_KEY_FILE")
[ -n "$TLS_SERVER_NAME" ] || fail "TLS_SERVER_NAME is missing"

exec 9>"$LOCK_FILE"
flock -n 9 || fail "another auth/admin deployment is running"

umask 077
{
  printf 'COMPOSE_PROJECT_NAME=%s\n' "$COMPOSE_PROJECT_NAME"
  printf 'RUNTIME_NETWORK=%s\n' "$RUNTIME_NETWORK"
  printf 'ORIGIN_HTTPS_PORT=%s\n' "$ORIGIN_HTTPS_PORT"
  printf 'APP_MEMORY_LIMIT=%s\n' "$APP_MEMORY_LIMIT"
  printf 'APP_CPU_LIMIT=%s\n' "$APP_CPU_LIMIT"
  printf 'APP_IMAGE=%s\n' "$PREVIOUS_IMAGE"
  printf 'APP_REVISION=%s\n' "$PREVIOUS_REVISION"
  printf 'APP_ENV_FILE=%s\n' "$APP_ENV"
  printf 'TLS_CERT_FILE=%s\n' "$TLS_CERT_FILE"
  printf 'TLS_KEY_FILE=%s\n' "$TLS_KEY_FILE"
  printf 'TLS_CA_FILE=%s\n' "$TLS_CA_FILE"
  printf 'TLS_READ_GID=%s\n' "$TLS_READ_GID"
} >"$RELEASE_ENV.tmp"
mv "$RELEASE_ENV.tmp" "$RELEASE_ENV"

compose() {
  docker compose --project-name "$COMPOSE_PROJECT_NAME" --file "$COMPOSE_FILE" --env-file "$RELEASE_ENV" "$@"
}

compose up --detach --no-deps "$SERVICE_NAME" || fail "previous container could not be started"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECONDS ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  container_id=$(compose ps --quiet "$SERVICE_NAME")
  if [ -n "$container_id" ]; then
    status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")
    [ "$status" = healthy ] && break
  fi
  sleep 2
done
[ "${status:-unknown}" = healthy ] || fail "previous container did not become healthy"
curl --fail --silent --show-error --cacert "$TLS_CA_FILE" --noproxy '*' \
  --resolve "$TLS_SERVER_NAME:$ORIGIN_HTTPS_PORT:127.0.0.1" \
  "https://$TLS_SERVER_NAME:$ORIGIN_HTTPS_PORT/health" >/dev/null \
  || fail "previous release failed host-local HTTPS readiness"
curl --fail --silent --show-error --retry 5 --retry-delay 3 "$PUBLIC_HEALTH_URL" >/dev/null \
  || fail "previous release failed public Cloudflare readiness"

ROLLED_BACK_AT=$(date -u '+%Y%m%dT%H%M%SZ')
state_candidate=$STATE_FILE.rollback.$$.tmp
cleanup() { rm -f -- "$state_candidate"; }
trap cleanup EXIT
{
  printf 'ACTIVE_IMAGE=%s\n' "$PREVIOUS_IMAGE"
  printf 'ACTIVE_REVISION=%s\n' "$PREVIOUS_REVISION"
  printf 'PREVIOUS_IMAGE=%s\n' "$ACTIVE_IMAGE"
  printf 'PREVIOUS_REVISION=%s\n' "$ACTIVE_REVISION"
  printf 'DEPLOYED_AT=%s\n' "$ROLLED_BACK_AT"
  printf 'GITHUB_RUN_ID=manual-rollback\n'
  printf 'CONFIG_SHA256=%s\n' "${CONFIG_SHA256:-unknown}"
} >"$state_candidate"
mv "$state_candidate" "$STATE_FILE"
echo "Rollback complete: $KIND runs $PREVIOUS_IMAGE"
