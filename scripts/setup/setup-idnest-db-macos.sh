#!/usr/bin/env bash
#
# Idnest identity bootstrap for macOS (Homebrew Postgres: current user is the superuser).
# Creates Hydra/Kratos/Authz roles, databases and schemas, then runs identity
# migrations. Database credentials are derived from the project DSNs.
#
# Usage: ./scripts/setup/setup-idnest-db-macos.sh
#
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_HELPER="$SCRIPT_DIR/load-project-env.sh"

# shellcheck source=scripts/setup/load-project-env.sh
. "$ENV_HELPER"
load_project_env "$REPO_ROOT"

HYDRA_IMAGE="${HYDRA_IMAGE:-oryd/hydra:v26.2.0}"
KRATOS_IMAGE="${KRATOS_IMAGE:-oryd/kratos:v26.2.0}"
KRATOS_CONFIG_DIR="${KRATOS_CONFIG_DIR:-$REPO_ROOT/config}"
PG_SUPERDB="${PG_SUPERDB:-postgres}"

require_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "Error: '$1' not found." >&2; exit 1; }; }
require_cmd psql
require_cmd docker
require_cmd node

derive_database_env

psql_super() { psql -v ON_ERROR_STOP=1 "$@"; }

ensure_role_db_schema() {
  local user="$1" pass="$2" db="$3" schema="$4"
  echo "==> Ensuring role '$user', database '$db' and schema '$schema'..."

  psql_super -d "$PG_SUPERDB" -v role="$user" -v pass="$pass" -v db="$db" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role', :'pass')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'role')\gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'role', :'pass')\gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'role')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'db')\gexec
SELECT format('GRANT ALL PRIVILEGES ON DATABASE %I TO %I', :'db', :'role')\gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', :'db', :'role')\gexec
SQL

  psql_super -d "$db" -v role="$user" -v schema="$schema" <<'SQL'
SELECT format('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION %I', :'schema', :'role')\gexec
SELECT format('GRANT USAGE, CREATE ON SCHEMA %I TO %I', :'schema', :'role')\gexec
SELECT format('ALTER ROLE %I IN DATABASE %I SET search_path = %I, public', :'role', current_database(), :'schema')\gexec
SQL
}

ensure_role_db_schema "$HYDRA_DB_USER" "$HYDRA_DB_PASSWORD" "$HYDRA_DB_NAME" "$HYDRA_DB_SCHEMA"
ensure_role_db_schema "$KRATOS_DB_USER" "$KRATOS_DB_PASSWORD" "$KRATOS_DB_NAME" "$KRATOS_DB_SCHEMA"
ensure_role_db_schema "$AUTHZ_DB_USER" "$AUTHZ_DB_PASSWORD" "$AUTHZ_DB_NAME" "$AUTHZ_DB_SCHEMA"

echo "==> Running Hydra migrations..."
docker run --rm \
  --add-host "host.docker.internal:host-gateway" \
  -e "DSN=$HYDRA_DSN" \
  "$HYDRA_IMAGE" migrate sql up -e --yes

echo "==> Running Kratos migrations..."
[ -d "$KRATOS_CONFIG_DIR" ] || { echo "Error: KRATOS_CONFIG_DIR='$KRATOS_CONFIG_DIR' not found." >&2; exit 1; }
docker run --rm \
  --add-host "host.docker.internal:host-gateway" \
  -e "DSN=$KRATOS_DSN" \
  -v "${KRATOS_CONFIG_DIR}:/etc/config" \
  "$KRATOS_IMAGE" migrate sql -e --yes

echo "==> Idnest Hydra and Kratos setup complete."
