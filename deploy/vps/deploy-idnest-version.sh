#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  echo "Idnest deployment failed: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

[[ $# -ge 1 && $# -le 2 ]] || fail "usage: deploy-idnest-version VERSION [auth|admin|all]"
VERSION=$1
COMPONENT=${2:-all}
[[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
  || fail "version must be an immutable semantic version such as 1.4.0"
case "$COMPONENT" in auth|admin|all) ;; *) fail "component must be auth, admin, or all" ;; esac
[[ ${EUID} -eq 0 ]] || fail "run this script as root"

for command in awk cp curl date docker flock grep install mktemp mv rm sleep stat; do
  require_command "$command"
done
docker compose version >/dev/null 2>&1 || fail "Docker Compose plugin is required"

readonly APP_ROOT=/opt/idnest
readonly CONFIG_ROOT=/etc/idnest
readonly STATE_ROOT=/var/lib/idnest
readonly DEPLOY_CONFIG=$CONFIG_ROOT/deploy.conf
readonly VALIDATOR=/usr/local/sbin/validate-idnest-app-env
readonly LOCK_FILE=/var/lock/idnest-deploy.lock

for file in "$DEPLOY_CONFIG" "$VALIDATOR" "$CONFIG_ROOT/idnest.conf"; do
  [[ -f "$file" && ! -L "$file" ]] || fail "required regular file is missing: $file"
done
[[ -x "$VALIDATOR" ]] || fail "environment validator is not executable"

require_root_secret() {
  local file=$1
  [[ -f "$file" && ! -L "$file" ]] || fail "required secret file is missing: $file"
  [[ $(stat -c '%U' "$file") == root ]] || fail "secret file must be owned by root: $file"
  [[ $(stat -c '%a' "$file") == 600 ]] || fail "secret file must have mode 600: $file"
}

require_root_secret "$DEPLOY_CONFIG"

# shellcheck source=/dev/null
source "$DEPLOY_CONFIG"
: "${ECR_PUBLIC_REGISTRY:?ECR_PUBLIC_REGISTRY is required in $DEPLOY_CONFIG}"
: "${AUTH_ECR_REPOSITORY:=idnest/auth-app}"
: "${ADMIN_ECR_REPOSITORY:=idnest/admin-app}"
: "${SKIP_PUBLIC_HEALTH_CHECK:=false}"
[[ "$ECR_PUBLIC_REGISTRY" =~ ^public\.ecr\.aws/[a-z0-9][a-z0-9._-]*$ ]] \
  || fail "ECR_PUBLIC_REGISTRY must be a public.ecr.aws registry alias"
for repository in "$AUTH_ECR_REPOSITORY" "$ADMIN_ECR_REPOSITORY"; do
  [[ "$repository" =~ ^[a-z0-9][a-z0-9._/-]*$ ]] || fail "invalid ECR Public repository: $repository"
done
case "$SKIP_PUBLIC_HEALTH_CHECK" in true|false) ;; *) fail "SKIP_PUBLIC_HEALTH_CHECK must be true or false" ;; esac

exec 9>"$LOCK_FILE"
flock -n 9 || fail "another Idnest deployment is running"

if [[ "$COMPONENT" == all ]]; then
  components=(auth admin)
else
  components=("$COMPONENT")
fi

declare -A image_refs=()
for kind in "${components[@]}"; do
  if [[ "$kind" == auth ]]; then
    repository=$AUTH_ECR_REPOSITORY
  else
    repository=$ADMIN_ECR_REPOSITORY
  fi
  tag_ref=$ECR_PUBLIC_REGISTRY/$repository:${kind}-v$VERSION
  echo "Pulling $tag_ref"
  docker pull "$tag_ref"
  digest_ref=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$tag_ref" \
    | awk -v prefix="$ECR_PUBLIC_REGISTRY/$repository@sha256:" 'index($0, prefix) == 1 { print; exit }')
  [[ "$digest_ref" =~ ^public\.ecr\.aws/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$ ]] \
    || fail "could not resolve a digest for $tag_ref"
  image_refs[$kind]=$digest_ref
done

start_identity() {
  local compose_file=$APP_ROOT/identity/compose.yaml
  local identity_env=$CONFIG_ROOT/idnest.env
  [[ -f "$compose_file" ]] || fail "identity Compose file is missing"
  require_root_secret "$identity_env"
  "$VALIDATOR" "$identity_env" identity >/dev/null
  # shellcheck source=/dev/null
  source "$CONFIG_ROOT/idnest.conf"
  : "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME is required in idnest.conf}"
  : "${IDNEST_RUNTIME_NETWORK:?IDNEST_RUNTIME_NETWORK is required in idnest.conf}"
  : "${HYDRA_PUBLIC_HEALTH_URL:?HYDRA_PUBLIC_HEALTH_URL is required in idnest.conf}"
  : "${KRATOS_PUBLIC_HEALTH_URL:?KRATOS_PUBLIC_HEALTH_URL is required in idnest.conf}"
  HYDRA_PUBLIC_HTTP_PORT=${HYDRA_PUBLIC_HTTP_PORT:-8446}
  HYDRA_ADMIN_HTTP_PORT=${HYDRA_ADMIN_HTTP_PORT:-4445}
  KRATOS_PUBLIC_HTTP_PORT=${KRATOS_PUBLIC_HTTP_PORT:-8447}
  KRATOS_ADMIN_HTTP_PORT=${KRATOS_ADMIN_HTTP_PORT:-4434}
  export COMPOSE_PROJECT_NAME IDNEST_RUNTIME_NETWORK HYDRA_PUBLIC_HTTP_PORT HYDRA_ADMIN_HTTP_PORT
  export KRATOS_PUBLIC_HTTP_PORT KRATOS_ADMIN_HTTP_PORT
  export IDNEST_ENV_FILE=$identity_env

  docker network inspect "$IDNEST_RUNTIME_NETWORK" >/dev/null 2>&1 \
    || docker network create "$IDNEST_RUNTIME_NETWORK" >/dev/null
  identity_compose=(docker compose --project-name "$COMPOSE_PROJECT_NAME" --file "$compose_file")
  "${identity_compose[@]}" config --quiet
  "${identity_compose[@]}" pull hydra
  "${identity_compose[@]}" build --pull kratos
  "${identity_compose[@]}" run --rm --no-deps --entrypoint sh hydra -c \
    'export DSN="$HYDRA_DSN"; exec hydra migrate sql up -e --yes'
  "${identity_compose[@]}" run --rm --no-deps --entrypoint sh kratos -c \
    'export DSN="$KRATOS_DSN"; exec kratos migrate sql -e --yes'
  "${identity_compose[@]}" up --detach
  wait_http "http://127.0.0.1:$HYDRA_ADMIN_HTTP_PORT/health/ready" "Hydra"
  wait_http "http://127.0.0.1:$KRATOS_PUBLIC_HTTP_PORT/health/ready" "Kratos"
  if [[ "$SKIP_PUBLIC_HEALTH_CHECK" == false ]]; then
    curl --fail --silent --show-error --retry 8 --retry-delay 3 "$HYDRA_PUBLIC_HEALTH_URL" >/dev/null
    curl --fail --silent --show-error --retry 8 --retry-delay 3 "$KRATOS_PUBLIC_HEALTH_URL" >/dev/null
  fi
}

wait_http() {
  local url=$1 name=$2 attempts=0
  until curl --fail --silent --show-error --noproxy '*' "$url" >/dev/null; do
    attempts=$((attempts + 1))
    [[ $attempts -lt 60 ]] || fail "$name did not become ready: $url"
    sleep 2
  done
}

start_identity

if [[ -x "$CONFIG_ROOT/pre-deploy-backup" ]]; then
  "$CONFIG_ROOT/pre-deploy-backup" "$COMPONENT" "$VERSION"
fi

migration_kind=${components[0]}
migration_env=$CONFIG_ROOT/${migration_kind}-app.env
require_root_secret "$migration_env"
"$VALIDATOR" "$migration_env" "$migration_kind" >/dev/null
# shellcheck source=/dev/null
source "$CONFIG_ROOT/idnest.conf"
docker run --rm --network "$IDNEST_RUNTIME_NETWORK" \
  --add-host host.docker.internal:host-gateway \
  --env-file "$migration_env" "${image_refs[$migration_kind]}" \
  node migrations/authz-migrate.cjs

if [[ -n ${image_refs[admin]:-} ]]; then
  require_root_secret "$CONFIG_ROOT/admin-app.env"
  "$VALIDATOR" "$CONFIG_ROOT/admin-app.env" admin >/dev/null
  docker run --rm --network "$IDNEST_RUNTIME_NETWORK" \
    --add-host host.docker.internal:host-gateway \
    --env-file "$CONFIG_ROOT/admin-app.env" "${image_refs[admin]}" \
    node scripts/setup/provision-admin-client.js
fi

rollback_root=$(mktemp -d "$STATE_ROOT/.rollback.XXXXXX")
changed_components=()
deployment_succeeded=false

restore_apps() {
  local status=$?
  if [[ "$deployment_succeeded" != true ]]; then
    echo "Restoring the previously active application image(s)." >&2
    for kind in "${changed_components[@]}"; do
      release_env=$APP_ROOT/$kind/release.env
      if [[ -f "$rollback_root/$kind.release.env" ]]; then
        install -o root -g root -m 600 "$rollback_root/$kind.release.env" "$release_env"
        compose_component "$kind" up --detach --no-deps "$kind" >/dev/null 2>&1 || true
      else
        compose_component "$kind" rm --force --stop "$kind" >/dev/null 2>&1 || true
        rm -f "$release_env"
      fi
    done
  fi
  rm -rf "$rollback_root"
  return "$status"
}
trap restore_apps EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

load_component() {
  local kind=$1
  unset COMPOSE_PROJECT_NAME RUNTIME_NETWORK PUBLIC_HEALTH_URL AUTH_HTTP_PORT ADMIN_HTTP_PORT
  unset APP_MEMORY_LIMIT APP_CPU_LIMIT HEALTH_TIMEOUT_SECONDS
  # shellcheck source=/dev/null
  source "$CONFIG_ROOT/$kind.conf"
  : "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME is required in $kind.conf}"
  : "${RUNTIME_NETWORK:?RUNTIME_NETWORK is required in $kind.conf}"
  : "${PUBLIC_HEALTH_URL:?PUBLIC_HEALTH_URL is required in $kind.conf}"
  APP_MEMORY_LIMIT=${APP_MEMORY_LIMIT:-768m}
  APP_CPU_LIMIT=${APP_CPU_LIMIT:-1.0}
  HEALTH_TIMEOUT_SECONDS=${HEALTH_TIMEOUT_SECONDS:-120}
  if [[ "$kind" == auth ]]; then
    HTTP_PORT=${AUTH_HTTP_PORT:-8444}
    HTTP_PORT_NAME=AUTH_HTTP_PORT
  else
    HTTP_PORT=${ADMIN_HTTP_PORT:-8445}
    HTTP_PORT_NAME=ADMIN_HTTP_PORT
  fi
}

compose_component() {
  local kind=$1
  shift
  load_component "$kind"
  docker compose --project-name "$COMPOSE_PROJECT_NAME" \
    --file "$APP_ROOT/$kind/compose.yaml" \
    --env-file "$APP_ROOT/$kind/release.env" "$@"
}

wait_component() {
  local kind=$1 deadline container_id status
  load_component "$kind"
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECONDS ))
  while [[ $(date +%s) -lt $deadline ]]; do
    container_id=$(compose_component "$kind" ps --quiet "$kind")
    if [[ -n "$container_id" ]]; then
      status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")
      [[ "$status" == healthy ]] && break
      [[ "$status" != exited && "$status" != dead ]] || return 1
    fi
    sleep 2
  done
  [[ ${status:-} == healthy ]] || return 1
  curl --fail --silent --show-error --noproxy '*' "http://127.0.0.1:$HTTP_PORT/health" >/dev/null
  if [[ "$SKIP_PUBLIC_HEALTH_CHECK" == false ]]; then
    curl --fail --silent --show-error --retry 5 --retry-delay 3 "$PUBLIC_HEALTH_URL" >/dev/null
  fi
}

for kind in "${components[@]}"; do
  app_env=$CONFIG_ROOT/$kind-app.env
  require_root_secret "$app_env"
  "$VALIDATOR" "$app_env" "$kind" >/dev/null
  load_component "$kind"
  release_env=$APP_ROOT/$kind/release.env
  [[ ! -f "$release_env" ]] || cp "$release_env" "$rollback_root/$kind.release.env"
  {
    printf 'COMPOSE_PROJECT_NAME=%s\n' "$COMPOSE_PROJECT_NAME"
    printf 'RUNTIME_NETWORK=%s\n' "$RUNTIME_NETWORK"
    printf '%s=%s\n' "$HTTP_PORT_NAME" "$HTTP_PORT"
    printf 'APP_MEMORY_LIMIT=%s\n' "$APP_MEMORY_LIMIT"
    printf 'APP_CPU_LIMIT=%s\n' "$APP_CPU_LIMIT"
    printf 'APP_IMAGE=%s\n' "${image_refs[$kind]}"
    printf 'APP_REVISION=%s\n' "$VERSION"
    printf 'APP_ENV_FILE=%s\n' "$app_env"
  } >"$rollback_root/$kind.candidate.env"
  install -o root -g root -m 600 "$rollback_root/$kind.candidate.env" "$release_env"
  changed_components+=("$kind")
  compose_component "$kind" config --quiet
  compose_component "$kind" up --detach --no-deps "$kind"
  wait_component "$kind" || {
    compose_component "$kind" logs --no-color --tail 100 "$kind" >&2 || true
    fail "$kind did not pass its readiness checks"
  }
done

deployed_at=$(date -u '+%Y%m%dT%H%M%SZ')
state_file=$STATE_ROOT/releases/$deployed_at-$VERSION-$COMPONENT.env
{
  printf 'VERSION=%s\n' "$VERSION"
  printf 'COMPONENT=%s\n' "$COMPONENT"
  printf 'DEPLOYED_AT=%s\n' "$deployed_at"
  [[ -z ${image_refs[auth]:-} ]] || printf 'AUTH_IMAGE=%s\n' "${image_refs[auth]}"
  [[ -z ${image_refs[admin]:-} ]] || printf 'ADMIN_IMAGE=%s\n' "${image_refs[admin]}"
} >"$rollback_root/state.env"
install -o root -g root -m 600 "$rollback_root/state.env" "$state_file"
install -o root -g root -m 600 "$rollback_root/state.env" "$STATE_ROOT/active.env"

deployment_succeeded=true
echo "Deployment complete: $COMPONENT version $VERSION"
echo "Rollback uses the same command with an older published version. Database migrations are forward-only."
