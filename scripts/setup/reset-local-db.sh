#!/usr/bin/env bash
#
# Destructive local reset for Idnest auth development.
# Clears local Hydra, Kratos, and Authz schemas, then runs the normal bootstrap
# path so migrations and the Idnest Admin infrastructure client are recreated.
#
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/scripts/docker/docker-compose.yml"
ENV_HELPER="$SCRIPT_DIR/load-project-env.sh"
BOOTSTRAP_LOCAL="$SCRIPT_DIR/bootstrap-local.sh"

usage() {
  echo "Usage: pnpm db:reset"
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

url_host() {
  node -e 'process.stdout.write(new URL(process.argv[1]).hostname)' "$1"
}

require_local_url() {
  local label="$1" url="$2" host
  host="$(url_host "$url")"
  case "$host" in
    localhost|127.0.0.1|::1|host.docker.internal) ;;
    *)
      echo "Error: refusing to reset non-local $label host '$host'." >&2
      exit 1
      ;;
  esac
}

local_psql_dsn() {
  node -e '
const url = new URL(process.argv[1]);
if (url.hostname === "host.docker.internal") url.hostname = "127.0.0.1";
process.stdout.write(url.toString());
' "$1"
}

require_resettable_schema() {
  local label="$1" schema="$2"
  case "$schema" in
    ""|public|pg_catalog|information_schema|pg_*)
      echo "Error: refusing to reset protected $label schema '$schema'." >&2
      exit 1
      ;;
  esac
}

reset_schema() {
  local label="$1" dsn="$2" schema="$3" owner="$4"

  echo "==> Clearing $label schema '$schema'..."
  psql "$dsn" -v ON_ERROR_STOP=1 -v schema="$schema" -v owner="$owner" <<'SQL'
DROP SCHEMA IF EXISTS :"schema" CASCADE;
CREATE SCHEMA :"schema" AUTHORIZATION :"owner";
GRANT USAGE, CREATE ON SCHEMA :"schema" TO :"owner";
SELECT format(
  'ALTER ROLE %I IN DATABASE %I SET search_path = %I, public',
  :'owner',
  current_database(),
  :'schema'
)\gexec
SQL
}

require_cmd node
require_cmd docker
require_cmd psql

# shellcheck source=scripts/setup/load-project-env.sh
. "$ENV_HELPER"
load_project_env "$REPO_ROOT"
derive_database_env

require_local_url "Hydra database" "$HYDRA_DSN"
require_local_url "Kratos database" "$KRATOS_DSN"
require_local_url "Authz database" "$AUTHZ_DATABASE_URL"
require_resettable_schema Hydra "$HYDRA_DB_SCHEMA"
require_resettable_schema Kratos "$KRATOS_DB_SCHEMA"
require_resettable_schema Authz "$AUTHZ_DB_SCHEMA"

HYDRA_LOCAL_DSN="$(local_psql_dsn "$HYDRA_DSN")"
KRATOS_LOCAL_DSN="$(local_psql_dsn "$KRATOS_DSN")"
AUTHZ_LOCAL_DSN="$(local_psql_dsn "$AUTHZ_DATABASE_URL")"

echo "==> Stopping local Hydra and Kratos containers..."
docker compose -f "$COMPOSE_FILE" down

reset_schema Hydra "$HYDRA_LOCAL_DSN" "$HYDRA_DB_SCHEMA" "$HYDRA_DB_USER"
reset_schema Kratos "$KRATOS_LOCAL_DSN" "$KRATOS_DB_SCHEMA" "$KRATOS_DB_USER"
reset_schema Authz "$AUTHZ_LOCAL_DSN" "$AUTHZ_DB_SCHEMA" "$AUTHZ_DB_USER"

echo "==> Recreating local services and the Idnest Admin client..."
"$BOOTSTRAP_LOCAL"

echo "==> Local database reset complete."
