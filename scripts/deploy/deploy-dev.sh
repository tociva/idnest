#!/usr/bin/env bash
#
# End-to-end development-server deployment:
#   1. fast-forward the checked-out Git branch
#   2. validate the deployment env files against both .env.example files
#   3. install dependencies and atomically activate the validated env files
#   4. stop PM2/Docker services and build each backend and frontend
#   5. run all database migrations
#   6. publish the frontend artifacts to the nginx document roots
#   7. start Docker/PM2 services and verify their health endpoints
#
# The env source files live outside the repository by default so secrets are
# not replaced by a pull. Override ROOT_ENV_SOURCE or MONOREPO_ENV_SOURCE when
# the server stores them elsewhere.
#
# Usage: ./scripts/deploy/deploy-dev.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MONOREPO_ROOT="$REPO_ROOT/monorepo"
COMPOSE_FILE="$REPO_ROOT/scripts/docker/docker-compose.yml"
ORY_RUNTIME_NETWORK="${ORY_RUNTIME_NETWORK:-ory-network}"
ENV_VALIDATOR="$REPO_ROOT/scripts/deploy/validate-env-file.mjs"
MIGRATION_RUNNER="$REPO_ROOT/scripts/deploy/run-migrations.sh"
FRONTEND_PUBLISHER="$REPO_ROOT/scripts/deploy/publish-nginx-frontends.sh"

ROOT_ENV_SOURCE="${ROOT_ENV_SOURCE:-$REPO_ROOT/../ory.root.env}"
MONOREPO_ENV_SOURCE="${MONOREPO_ENV_SOURCE:-$REPO_ROOT/../ory.monorepo.env}"
ROOT_ENV_EXAMPLE="$REPO_ROOT/.env.example"
MONOREPO_ENV_EXAMPLE="$MONOREPO_ROOT/.env.example"
ROOT_ENV_TARGET="$REPO_ROOT/.env"
MONOREPO_ENV_TARGET="$MONOREPO_ROOT/.env"

AUTH_FRONTEND_ROOT="${AUTH_FRONTEND_ROOT:-/var/www/auth-frontend/browser}"
ADMIN_FRONTEND_ROOT="${ADMIN_FRONTEND_ROOT:-/var/www/admin-frontend-dev}"
ADMIN_FRONTEND_API_BASE_URL="${ADMIN_FRONTEND_API_BASE_URL:-/api}"
ADMIN_FRONTEND_AUTH_LOGOUT_URL="${ADMIN_FRONTEND_AUTH_LOGOUT_URL:-https://auth-dev.idnest.cloud/logout}"
ADMIN_FRONTEND_GENERATED_SOURCE_CONFIG="$MONOREPO_ROOT/apps/admin-frontend/public/config/config.json"
AUTH_PM2_NAME="${AUTH_PM2_NAME:-idnest-auth-backend}"
ADMIN_PM2_NAME="${ADMIN_PM2_NAME:-idnest-admin-backend}"
AUTH_BACKEND_BUNDLE="$MONOREPO_ROOT/dist/apps/auth-backend/main.cjs"
ADMIN_BACKEND_BUNDLE="$MONOREPO_ROOT/dist/apps/admin-backend/main.cjs"

HYDRA_READY_URL="${HYDRA_READY_URL:-http://127.0.0.1:4445/health/ready}"
KRATOS_READY_URL="${KRATOS_READY_URL:-http://127.0.0.1:4433/health/ready}"
AUTH_READY_URL="${AUTH_READY_URL:-http://127.0.0.1:4000/health}"
ADMIN_READY_URL="${ADMIN_READY_URL:-http://127.0.0.1:4100/health}"
HEALTHCHECK_ATTEMPTS="${HEALTHCHECK_ATTEMPTS:-60}"
HEALTHCHECK_INTERVAL_SECONDS="${HEALTHCHECK_INTERVAL_SECONDS:-2}"

CURRENT_PHASE="initialization"
SERVICES_STOPPED=false
STAGING_DIR=""

cd "$REPO_ROOT"

phase() {
  CURRENT_PHASE="$1"
  echo
  echo "==> $CURRENT_PHASE"
}

require_commands() {
  local required
  for required in "$@"; do
    command -v "$required" >/dev/null 2>&1 || {
      echo "Required command not found: $required" >&2
      return 1
    }
  done
}

cleanup() {
  if [ -n "$STAGING_DIR" ] && [ -d "$STAGING_DIR" ]; then
    rm -rf -- "$STAGING_DIR"
  fi
}

deployment_failed() {
  local status="$?"
  trap - ERR
  echo >&2
  echo "Deployment failed during: $CURRENT_PHASE" >&2
  if [ "$SERVICES_STOPPED" = true ]; then
    echo "The previous release was stopped and startup of the new release did not complete." >&2
    echo "Inspect 'docker compose ... ps' and 'pm2 status' before retrying." >&2
    echo "Fix the reported error, then rerun pnpm deploy:dev." >&2
  fi
  exit "$status"
}

validate_healthcheck_settings() {
  [[ "$HEALTHCHECK_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || {
    echo "HEALTHCHECK_ATTEMPTS must be a positive integer." >&2
    return 1
  }
  [[ "$HEALTHCHECK_INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || {
    echo "HEALTHCHECK_INTERVAL_SECONDS must be a non-negative integer." >&2
    return 1
  }
}

validate_environment_files() {
  local failed=0

  node "$ENV_VALIDATOR" \
    "$ROOT_ENV_EXAMPLE" "$ROOT_ENV_SOURCE" "root deployment environment" ||
    failed=1
  node "$ENV_VALIDATOR" \
    "$MONOREPO_ENV_EXAMPLE" "$MONOREPO_ENV_SOURCE" "monorepo deployment environment" ||
    failed=1

  [ "$failed" -eq 0 ]
}

stage_environment_files() {
  STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ory-auth-deploy.XXXXXX")"
  chmod 0700 "$STAGING_DIR"
  install -m 0600 "$ROOT_ENV_SOURCE" "$STAGING_DIR/root.env"
  install -m 0600 "$MONOREPO_ENV_SOURCE" "$STAGING_DIR/monorepo.env"
}

install_environment_file() {
  local source="$1" target="$2" temporary
  temporary="$(mktemp "${target}.deploy.XXXXXX")"
  if ! install -m 0600 "$source" "$temporary"; then
    rm -f -- "$temporary"
    return 1
  fi
  if ! mv -f "$temporary" "$target"; then
    rm -f -- "$temporary"
    return 1
  fi
}

stop_pm2_process() {
  local name="$1"
  if pm2 describe "$name" >/dev/null 2>&1; then
    pm2 stop "$name"
  else
    echo "PM2 process is not registered; skipping: $name"
  fi
}

replace_pm2_process() {
  local name="$1" bundle="$2"
  if pm2 describe "$name" >/dev/null 2>&1; then
    pm2 delete "$name"
  fi
  pm2 start "$bundle" --name "$name" --cwd "$MONOREPO_ROOT"
}

pm2_process_snapshot() {
  local name="$1"
  pm2 jlist | node -e '
const name = process.argv[1];
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const processInfo = JSON.parse(input).find((entry) => entry.name === name);
  if (!processInfo) process.exit(1);
  const status = processInfo.pm2_env?.status ?? "unknown";
  const restarts = processInfo.pm2_env?.restart_time ?? -1;
  process.stdout.write(`${status}:${processInfo.pid}:${restarts}`);
});
' "$name"
}

verify_pm2_process_stability() {
  local auth_before admin_before auth_after admin_after

  auth_before="$(pm2_process_snapshot "$AUTH_PM2_NAME")"
  admin_before="$(pm2_process_snapshot "$ADMIN_PM2_NAME")"
  sleep 5
  auth_after="$(pm2_process_snapshot "$AUTH_PM2_NAME")"
  admin_after="$(pm2_process_snapshot "$ADMIN_PM2_NAME")"

  if [[ "$auth_after" != online:* ]] || [ "$auth_before" != "$auth_after" ]; then
    echo "PM2 process is not stable: $AUTH_PM2_NAME ($auth_before -> $auth_after)" >&2
    pm2 logs "$AUTH_PM2_NAME" --lines 30 --nostream >&2 || true
    return 1
  fi
  if [[ "$admin_after" != online:* ]] || [ "$admin_before" != "$admin_after" ]; then
    echo "PM2 process is not stable: $ADMIN_PM2_NAME ($admin_before -> $admin_after)" >&2
    pm2 logs "$ADMIN_PM2_NAME" --lines 30 --nostream >&2 || true
    return 1
  fi
}

wait_for_url() {
  local label="$1" url="$2" attempt=1
  echo "Waiting for $label at $url..."
  while [ "$attempt" -le "$HEALTHCHECK_ATTEMPTS" ]; do
    if curl --connect-timeout 2 --max-time 5 -fsS "$url" >/dev/null 2>&1; then
      echo "$label is ready."
      return 0
    fi
    sleep "$HEALTHCHECK_INTERVAL_SECONDS"
    attempt=$((attempt + 1))
  done
  echo "$label did not become ready at $url." >&2
  return 1
}

trap cleanup EXIT
trap deployment_failed ERR

require_commands git

phase "Updating the repository"
git pull --ff-only

phase "Validating deployment inputs"
require_commands chmod curl docker install mktemp mv node pm2 pnpm rm rsync sleep
validate_healthcheck_settings

if ! docker network inspect "$ORY_RUNTIME_NETWORK" >/dev/null 2>&1; then
  docker network create --attachable "$ORY_RUNTIME_NETWORK" >/dev/null
fi
export ORY_RUNTIME_NETWORK

for required_file in \
  "$COMPOSE_FILE" \
  "$ENV_VALIDATOR" \
  "$MIGRATION_RUNNER" \
  "$FRONTEND_PUBLISHER"; do
  [ -f "$required_file" ] || {
    echo "Required deployment file not found: $required_file" >&2
    exit 1
  }
done

validate_environment_files
stage_environment_files

phase "Installing workspace dependencies"
pnpm workspace:install --frozen-lockfile

# Generated runtime configuration belongs only in the published document root.
# Remove a developer-local copy before Angular copies public/ into the build.
rm -f "$ADMIN_FRONTEND_GENERATED_SOURCE_CONFIG"

# Docker Compose must be able to read the new root env even on a first deploy,
# and migrations must use the same values as the services that follow.
phase "Installing validated environment files"
install_environment_file "$STAGING_DIR/root.env" "$ROOT_ENV_TARGET"
install_environment_file "$STAGING_DIR/monorepo.env" "$MONOREPO_ENV_TARGET"

phase "Stopping application services"
SERVICES_STOPPED=true
stop_pm2_process "$AUTH_PM2_NAME"
stop_pm2_process "$ADMIN_PM2_NAME"
docker compose -f "$COMPOSE_FILE" down --remove-orphans

phase "Building all applications"
for project in auth-backend auth-frontend admin-backend admin-frontend; do
  echo "Building $project..."
  pnpm "${project}:build"
done

for bundle in "$AUTH_BACKEND_BUNDLE" "$ADMIN_BACKEND_BUNDLE"; do
  [ -f "$bundle" ] || {
    echo "Backend build output not found: $bundle" >&2
    exit 1
  }
done

phase "Running database migrations"
pnpm db:migrate

phase "Publishing frontend artifacts"
AUTH_FRONTEND_ROOT="$AUTH_FRONTEND_ROOT" \
ADMIN_FRONTEND_ROOT="$ADMIN_FRONTEND_ROOT" \
ADMIN_FRONTEND_API_BASE_URL="$ADMIN_FRONTEND_API_BASE_URL" \
ADMIN_FRONTEND_AUTH_LOGOUT_URL="$ADMIN_FRONTEND_AUTH_LOGOUT_URL" \
  "$FRONTEND_PUBLISHER"

phase "Starting Docker and PM2 services"
docker compose -f "$COMPOSE_FILE" up -d --build
replace_pm2_process "$AUTH_PM2_NAME" "$AUTH_BACKEND_BUNDLE"
replace_pm2_process "$ADMIN_PM2_NAME" "$ADMIN_BACKEND_BUNDLE"
verify_pm2_process_stability
pm2 save
SERVICES_STOPPED=false

phase "Verifying service health"
wait_for_url "Hydra" "$HYDRA_READY_URL"
wait_for_url "Kratos" "$KRATOS_READY_URL"
wait_for_url "Auth backend" "$AUTH_READY_URL"
wait_for_url "Admin backend" "$ADMIN_READY_URL"

docker compose -f "$COMPOSE_FILE" ps
pm2 status

phase "Deployment complete"
echo "Auth frontend:  $AUTH_FRONTEND_ROOT"
echo "Admin frontend: $ADMIN_FRONTEND_ROOT"
