#!/usr/bin/env bash
#
# Local one-shot bootstrap for Idnest auth development.
# Creates local Postgres roles/databases/schemas, runs migrations, starts Idnest
# containers, and provisions the Idnest Admin console's infrastructure client.
#
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/scripts/docker/docker-compose.yml"
IDNEST_RUNTIME_NETWORK="${IDNEST_RUNTIME_NETWORK:-idnest-network}"
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
require_cmd mktemp
require_cmd openssl
require_cmd pnpm

# shellcheck source=scripts/setup/load-project-env.sh
. "$ENV_HELPER"
load_project_env "$REPO_ROOT"

apple_value_count=0
for apple_key in APPLE_CLIENT_ID APPLE_TEAM_ID APPLE_PRIVATE_KEY_ID APPLE_PRIVATE_KEY; do
  eval "apple_value=\${$apple_key:-}"
  [ -z "$apple_value" ] || apple_value_count=$((apple_value_count + 1))
done
case "$apple_value_count" in
  0) ;;
  4)
    [[ "$APPLE_CLIENT_ID" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{2,254}$ ]] || {
      echo "Error: APPLE_CLIENT_ID must be a valid Apple Services ID." >&2
      exit 1
    }
    [[ "$APPLE_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || {
      echo "Error: APPLE_TEAM_ID must be a 10-character Apple Team ID." >&2
      exit 1
    }
    [[ "$APPLE_PRIVATE_KEY_ID" =~ ^[A-Z0-9]{10}$ ]] || {
      echo "Error: APPLE_PRIVATE_KEY_ID must be a 10-character Apple Key ID." >&2
      exit 1
    }
    apple_key_file=$(mktemp "${TMPDIR:-/tmp}/idnest-local-apple-key.XXXXXX")
    cleanup_apple_key() {
      rm -f -- "$apple_key_file"
    }
    trap cleanup_apple_key EXIT HUP INT TERM
    chmod 600 "$apple_key_file"
    printf '%b' "$APPLE_PRIVATE_KEY" >"$apple_key_file"
    "$REPO_ROOT/scripts/deploy/validate-apple-private-key.sh" "$apple_key_file" >/dev/null
    rm -f -- "$apple_key_file"
    trap - EXIT HUP INT TERM
    ;;
  *)
    echo "Error: Apple login requires APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_PRIVATE_KEY_ID, and APPLE_PRIVATE_KEY together." >&2
    exit 1
    ;;
esac

if ! docker network inspect "$IDNEST_RUNTIME_NETWORK" >/dev/null 2>&1; then
  docker network create --attachable "$IDNEST_RUNTIME_NETWORK" >/dev/null
fi
export IDNEST_RUNTIME_NETWORK

case "$(uname -s)" in
  Darwin) SETUP_SCRIPT="$REPO_ROOT/scripts/setup/setup-idnest-db-macos.sh" ;;
  Linux) SETUP_SCRIPT="$REPO_ROOT/scripts/setup/setup-idnest-db-linux.sh" ;;
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
