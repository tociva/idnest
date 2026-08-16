#!/usr/bin/env bash
#
# Local one-shot bootstrap for Idnest auth development.
# Creates local Postgres roles/databases/schemas, runs migrations, starts ORY
# containers, and provisions the Idnest Admin console's infrastructure client.
#
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/scripts/docker/docker-compose.yml"
ORY_RUNTIME_NETWORK="${ORY_RUNTIME_NETWORK:-ory-network}"
ENV_HELPER="$SCRIPT_DIR/load-project-env.sh"
ADMIN_CLIENT_PROVISIONER="$SCRIPT_DIR/provision-admin-client.js"

usage() {
  echo "Usage: pnpm bootstrap:local"
}

case "${1:-}" in
  "")
    ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    echo "Error: unknown argument '$1'." >&2
    usage >&2
    exit 2
    ;;
esac

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Error: '$1' not found." >&2
    exit 1
  }
}

wait_for_url() {
  local label="$1" url="$2" tries="${3:-60}"
  echo "==> Waiting for $label..."
  for _ in $(seq 1 "$tries"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "==> $label is ready."
      return 0
    fi
    sleep 2
  done
  echo "Error: $label did not become ready at $url." >&2
  return 1
}

require_cmd node
require_cmd docker
require_cmd curl
require_cmd pnpm

if ! docker network inspect "$ORY_RUNTIME_NETWORK" >/dev/null 2>&1; then
  docker network create --attachable "$ORY_RUNTIME_NETWORK" >/dev/null
fi
export ORY_RUNTIME_NETWORK

# shellcheck source=scripts/setup/load-project-env.sh
. "$ENV_HELPER"
load_project_env "$REPO_ROOT"

case "$(uname -s)" in
  Darwin) SETUP_SCRIPT="$REPO_ROOT/scripts/setup/setup-ory-db-macos.sh" ;;
  Linux) SETUP_SCRIPT="$REPO_ROOT/scripts/setup/setup-ory-db-linux.sh" ;;
  *) echo "Error: unsupported OS '$(uname -s)'." >&2; exit 1 ;;
esac

"$SETUP_SCRIPT"

echo "==> Running authz migrations..."
pnpm --dir="$REPO_ROOT" authz:migrate

echo "==> Starting Hydra and Kratos containers..."
docker compose -f "$COMPOSE_FILE" up -d --build

wait_for_url "Hydra" "http://localhost:4445/health/ready"
wait_for_url "Kratos" "http://localhost:4433/health/ready"

if [ -z "${ADMIN_OIDC_CLIENT_SECRET:-}" ]; then
  echo "Error: ADMIN_OIDC_CLIENT_SECRET is required for the confidential admin client." >&2
  exit 1
fi

echo "==> Provisioning the Idnest Admin infrastructure client..."
node "$ADMIN_CLIENT_PROVISIONER"

echo "==> Local auth bootstrap complete."
