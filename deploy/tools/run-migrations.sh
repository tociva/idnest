#!/usr/bin/env bash
#
# Run all schema migrations required by a deployed release. Database roles and
# databases must already exist; use scripts/setup/setup-idnest-db-<os>.sh for the
# one-time provisioning step.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_HELPER="$REPO_ROOT/scripts/setup/load-project-env.sh"

HYDRA_IMAGE="${HYDRA_IMAGE:-oryd/hydra:v26.2.0}"
KRATOS_IMAGE="${KRATOS_IMAGE:-oryd/kratos:v26.2.0}"
KRATOS_CONFIG_DIR="${KRATOS_CONFIG_DIR:-$REPO_ROOT/config}"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Required command not found: $1" >&2
    exit 1
  }
}

require_cmd docker
require_cmd node
require_cmd pnpm

# shellcheck source=scripts/setup/load-project-env.sh
. "$ENV_HELPER"
load_project_env "$REPO_ROOT"
derive_database_env

[ -d "$KRATOS_CONFIG_DIR" ] || {
  echo "Kratos configuration directory not found: $KRATOS_CONFIG_DIR" >&2
  exit 1
}

echo "==> Migrating Hydra..."
docker run --rm \
  --add-host "host.docker.internal:host-gateway" \
  -e "DSN=$HYDRA_DSN" \
  "$HYDRA_IMAGE" migrate sql up -e --yes

echo "==> Migrating Kratos..."
docker run --rm \
  --add-host "host.docker.internal:host-gateway" \
  -e "DSN=$KRATOS_DSN" \
  -v "${KRATOS_CONFIG_DIR}:/etc/config:ro" \
  "$KRATOS_IMAGE" migrate sql -e --yes

echo "==> Migrating the authorization database..."
pnpm --dir="$REPO_ROOT" authz:migrate

echo "==> All database migrations completed."
