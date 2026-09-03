#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Development VPS PostgreSQL setup failed: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  scripts/deploy/setup-development-vps-postgres.sh \
    VPS_ADMIN_USER VPS_ADMIN_SSH_KEY DEVELOPMENT_ENV [VPS_HOST] [VPS_PORT]

Installs and configures PostgreSQL on the development VPS, then creates or
updates the Hydra, Kratos, and Authz roles/databases using the DSNs from the
protected development environment file. DEVELOPMENT_ENV is read locally and is
not copied to the VPS.
EOF
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
esac
if [ "$#" -lt 3 ] || [ "$#" -gt 5 ]; then
  usage >&2
  exit 2
fi

VPS_ADMIN_USER=$1
VPS_ADMIN_SSH_KEY=$2
DEVELOPMENT_ENV=$3

case "$VPS_ADMIN_USER" in
  root|idnest-deploy) fail "VPS_ADMIN_USER must be a separate non-root administrative account" ;;
  ""|*[!a-z0-9_-]*|[!a-z_]*) fail "VPS_ADMIN_USER is not a valid Linux account name" ;;
esac
if ! {
  [ -f "$VPS_ADMIN_SSH_KEY" ] &&
    [ ! -L "$VPS_ADMIN_SSH_KEY" ] &&
    [ -s "$VPS_ADMIN_SSH_KEY" ]
}; then
  fail "VPS_ADMIN_SSH_KEY must be a non-empty regular file"
fi
if ! {
  [ -f "$DEVELOPMENT_ENV" ] &&
    [ ! -L "$DEVELOPMENT_ENV" ] &&
    [ -s "$DEVELOPMENT_ENV" ]
}; then
  fail "DEVELOPMENT_ENV must be a non-empty regular file"
fi

for command in awk cat chmod grep mktemp node rm scp ssh ssh-keygen stat uname; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

SCRIPT_DIR=$(CDPATH='' cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd "$SCRIPT_DIR/../.." && pwd)
REPO_PARENT=$(CDPATH='' cd "$REPO_ROOT/.." && pwd)
KNOWN_HOSTS=$REPO_PARENT/idnest-secure/vps-known-hosts

file_mode() {
  if [ "$(uname -s)" = Darwin ]; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

[ "$(file_mode "$DEVELOPMENT_ENV")" = 600 ] \
  || fail "DEVELOPMENT_ENV must have mode 600"

dotenv_value() {
  local source_file=$1 wanted_key=$2
  awk -v wanted="$wanted_key" '
    index($0, "=") > 0 {
      key = substr($0, 1, index($0, "=") - 1)
      if (key == wanted) {
        value = substr($0, index($0, "=") + 1)
        if (value ~ /^".*"$/ || value ~ /^\047.*\047$/) {
          value = substr(value, 2, length(value) - 2)
        }
        print value
        exit
      }
    }
  ' "$source_file"
}

database_url_part() {
  local label=$1 url=$2 part=$3
  node -e '
const label = process.argv[1];
const raw = process.argv[2];
const part = process.argv[3];
let url;
try {
  url = new URL(raw);
} catch (error) {
  throw new Error(label + " is not a valid URL: " + error.message);
}
if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
  throw new Error(label + " must be a PostgreSQL DSN");
}
if (url.hostname !== "host.docker.internal") {
  throw new Error(label + " must target host.docker.internal for VPS-local PostgreSQL");
}
if ((url.port || "5432") !== "5432") {
  throw new Error(label + " must use port 5432 for VPS-local PostgreSQL");
}
if ((url.searchParams.get("sslmode") || "") !== "disable") {
  throw new Error(label + " must include sslmode=disable for VPS-local PostgreSQL");
}
const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
const values = {
  username: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database,
};
if (!values[part]) {
  throw new Error(label + " must include a " + part);
}
process.stdout.write(values[part]);
' "$label" "$url" "$part"
}

require_pg_identifier() {
  local label=$1 value=$2
  [[ "$value" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] \
    || fail "$label must be a simple PostgreSQL identifier"
}

VPS_HOST=${4:-$(dotenv_value "$DEVELOPMENT_ENV" VPS_HOST)}
VPS_PORT=${5:-$(dotenv_value "$DEVELOPMENT_ENV" VPS_PORT)}
HYDRA_DSN=$(dotenv_value "$DEVELOPMENT_ENV" HYDRA_DSN)
KRATOS_DSN=$(dotenv_value "$DEVELOPMENT_ENV" KRATOS_DSN)
AUTHZ_DATABASE_URL=$(dotenv_value "$DEVELOPMENT_ENV" AUTHZ_DATABASE_URL)

case "$VPS_HOST" in
  ""|-*|*[!A-Za-z0-9.-]*) fail "VPS_HOST must be a hostname or IP address" ;;
esac
printf '%s\n' "$VPS_PORT" | grep -Eq '^[1-9][0-9]{0,4}$' \
  || fail "VPS_PORT must be an integer from 1 to 65535"
[ "$VPS_PORT" -le 65535 ] || fail "VPS_PORT must be an integer from 1 to 65535"
if ! {
  [ -f "$KNOWN_HOSTS" ] &&
    [ ! -L "$KNOWN_HOSTS" ] &&
    [ -s "$KNOWN_HOSTS" ]
}; then
  fail "$KNOWN_HOSTS is missing; run create-development-credentials.sh first"
fi
known_host=$VPS_HOST
if [ "$VPS_PORT" -ne 22 ]; then
  known_host=[$VPS_HOST]:$VPS_PORT
fi
ssh-keygen -F "$known_host" -f "$KNOWN_HOSTS" >/dev/null \
  || fail "$KNOWN_HOSTS has no entry for $known_host; regenerate credentials for this endpoint"

HYDRA_DB_USER=$(database_url_part HYDRA_DSN "$HYDRA_DSN" username)
HYDRA_DB_PASSWORD=$(database_url_part HYDRA_DSN "$HYDRA_DSN" password)
HYDRA_DB_NAME=$(database_url_part HYDRA_DSN "$HYDRA_DSN" database)
KRATOS_DB_USER=$(database_url_part KRATOS_DSN "$KRATOS_DSN" username)
KRATOS_DB_PASSWORD=$(database_url_part KRATOS_DSN "$KRATOS_DSN" password)
KRATOS_DB_NAME=$(database_url_part KRATOS_DSN "$KRATOS_DSN" database)
AUTHZ_DB_USER=$(database_url_part AUTHZ_DATABASE_URL "$AUTHZ_DATABASE_URL" username)
AUTHZ_DB_PASSWORD=$(database_url_part AUTHZ_DATABASE_URL "$AUTHZ_DATABASE_URL" password)
AUTHZ_DB_NAME=$(database_url_part AUTHZ_DATABASE_URL "$AUTHZ_DATABASE_URL" database)

require_pg_identifier HYDRA_DB_USER "$HYDRA_DB_USER"
require_pg_identifier HYDRA_DB_NAME "$HYDRA_DB_NAME"
require_pg_identifier KRATOS_DB_USER "$KRATOS_DB_USER"
require_pg_identifier KRATOS_DB_NAME "$KRATOS_DB_NAME"
require_pg_identifier AUTHZ_DB_USER "$AUTHZ_DB_USER"
require_pg_identifier AUTHZ_DB_NAME "$AUTHZ_DB_NAME"

quote_shell() {
  printf '%q' "$1"
}

ssh_args=(
  -i "$VPS_ADMIN_SSH_KEY"
  -p "$VPS_PORT"
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$KNOWN_HOSTS"
)
scp_args=(
  -i "$VPS_ADMIN_SSH_KEY"
  -P "$VPS_PORT"
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$KNOWN_HOSTS"
)

remote_values=$(
  printf 'HYDRA_DB_USER=%s\n' "$(quote_shell "$HYDRA_DB_USER")"
  printf 'HYDRA_DB_PASSWORD=%s\n' "$(quote_shell "$HYDRA_DB_PASSWORD")"
  printf 'HYDRA_DB_NAME=%s\n' "$(quote_shell "$HYDRA_DB_NAME")"
  printf 'KRATOS_DB_USER=%s\n' "$(quote_shell "$KRATOS_DB_USER")"
  printf 'KRATOS_DB_PASSWORD=%s\n' "$(quote_shell "$KRATOS_DB_PASSWORD")"
  printf 'KRATOS_DB_NAME=%s\n' "$(quote_shell "$KRATOS_DB_NAME")"
  printf 'AUTHZ_DB_USER=%s\n' "$(quote_shell "$AUTHZ_DB_USER")"
  printf 'AUTHZ_DB_PASSWORD=%s\n' "$(quote_shell "$AUTHZ_DB_PASSWORD")"
  printf 'AUTHZ_DB_NAME=%s\n' "$(quote_shell "$AUTHZ_DB_NAME")"
)

temporary_parent=${TMPDIR:-/tmp}
temporary_parent=${temporary_parent%/}
local_work_directory=$(mktemp -d "$temporary_parent/idnest-vps-postgres.XXXXXX")
remote_script=$local_work_directory/setup-development-vps-postgres-remote.sh
remote_script_path=idnest-postgres-setup/setup-development-vps-postgres-remote.$$
cleanup() {
  case "${local_work_directory:-}" in
    "$temporary_parent"/idnest-vps-postgres.*)
      [ ! -L "$local_work_directory" ] && rm -rf -- "$local_work_directory"
      ;;
  esac
}
trap cleanup EXIT HUP INT TERM

cat >"$remote_script" <<REMOTE
set -euo pipefail

$remote_values

RUNTIME_NETWORK=idnest-runtime-development
RUNTIME_SUBNET=172.23.0.0/16

fail() {
  echo "Remote PostgreSQL setup failed: \$*" >&2
  exit 1
}

require_command() {
  command -v "\$1" >/dev/null 2>&1 || fail "missing required command: \$1"
}

if [ "\$(id -u)" -eq 0 ]; then
  fail "run this through the non-root VPS administrative account"
fi
require_command sudo
require_command grep
require_command awk
require_command getent
require_command systemctl

if [ -r /etc/os-release ]; then
  # shellcheck source=/dev/null
  . /etc/os-release
else
  fail "cannot detect the VPS operating system"
fi
case "\${ID:-}" in
  ubuntu|debian) ;;
  *) fail "automatic PostgreSQL setup supports only Debian or Ubuntu" ;;
esac

if ! command -v psql >/dev/null 2>&1 ||
  ! getent passwd postgres >/dev/null ||
  ! systemctl list-unit-files postgresql.service 2>/dev/null | grep -q '^postgresql\.service'; then
  require_command apt-get
  sudo apt-get update
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql postgresql-client
fi

sudo systemctl enable --now postgresql
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 \
  -c "ALTER SYSTEM SET listen_addresses TO '*';" \
  -c "ALTER SYSTEM SET password_encryption TO 'scram-sha-256';"

ensure_role_db_schema() {
  db_user=\$1
  db_password=\$2
  db_name=\$3
  db_schema=\$3

  sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 \
    -v role="\$db_user" -v pass="\$db_password" -v db="\$db_name" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role', :'pass')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'role')\gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'role', :'pass')\gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'role')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'db')\gexec
SELECT format('GRANT ALL PRIVILEGES ON DATABASE %I TO %I', :'db', :'role')\gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', :'db', :'role')\gexec
SQL

  sudo -u postgres psql -d "\$db_name" -v ON_ERROR_STOP=1 \
    -v role="\$db_user" -v schema="\$db_schema" <<'SQL'
SELECT format('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION %I', :'schema', :'role')\gexec
SELECT format('GRANT USAGE, CREATE ON SCHEMA %I TO %I', :'schema', :'role')\gexec
SELECT format('ALTER ROLE %I IN DATABASE %I SET search_path = %I, public', :'role', current_database(), :'schema')\gexec
SQL
}

ensure_role_db_schema "\$HYDRA_DB_USER" "\$HYDRA_DB_PASSWORD" "\$HYDRA_DB_NAME"
ensure_role_db_schema "\$KRATOS_DB_USER" "\$KRATOS_DB_PASSWORD" "\$KRATOS_DB_NAME"
ensure_role_db_schema "\$AUTHZ_DB_USER" "\$AUTHZ_DB_PASSWORD" "\$AUTHZ_DB_NAME"

hba_file=\$(sudo -u postgres psql -d postgres -Atc 'SHOW hba_file;')
[ -n "\$hba_file" ] || fail "could not determine pg_hba.conf path"
[ ! -L "\$hba_file" ] || fail "refusing to edit symbolic-link pg_hba.conf: \$hba_file"

ensure_hba_line() {
  db_name=\$1
  db_user=\$2
  if ! sudo awk -v db="\$db_name" -v user="\$db_user" -v subnet="\$RUNTIME_SUBNET" \
    '\$1 == "hostnossl" && \$2 == db && \$3 == user && \$4 == subnet && \$5 == "scram-sha-256" { found = 1 } END { exit found ? 0 : 1 }' \
    "\$hba_file"; then
    printf 'hostnossl  %s  %s  %s  scram-sha-256\n' "\$db_name" "\$db_user" "\$RUNTIME_SUBNET" \
      | sudo tee -a "\$hba_file" >/dev/null
  fi
}

ensure_hba_line "\$HYDRA_DB_NAME" "\$HYDRA_DB_USER"
ensure_hba_line "\$KRATOS_DB_NAME" "\$KRATOS_DB_USER"
ensure_hba_line "\$AUTHZ_DB_NAME" "\$AUTHZ_DB_USER"

sudo systemctl restart postgresql
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT line_number, type, database, user_name, address, auth_method, error FROM pg_hba_file_rules WHERE database && ARRAY['\$HYDRA_DB_NAME','\$KRATOS_DB_NAME','\$AUTHZ_DB_NAME'];"

require_command docker
sudo docker network inspect "\$RUNTIME_NETWORK" >/dev/null \
  || fail "Docker network \$RUNTIME_NETWORK is missing; run bootstrap-development-vps.sh first"

check_from_docker() {
  db_user=\$1
  db_password=\$2
  db_name=\$3
  sudo docker run --rm \
    --network "\$RUNTIME_NETWORK" \
    --add-host host.docker.internal:host-gateway \
    -e PGPASSWORD="\$db_password" \
    postgres:17-alpine \
    psql -h host.docker.internal -p 5432 -U "\$db_user" -d "\$db_name" \
      -v ON_ERROR_STOP=1 -c 'SELECT 1;'
}

check_from_docker "\$HYDRA_DB_USER" "\$HYDRA_DB_PASSWORD" "\$HYDRA_DB_NAME"
check_from_docker "\$KRATOS_DB_USER" "\$KRATOS_DB_PASSWORD" "\$KRATOS_DB_NAME"
check_from_docker "\$AUTHZ_DB_USER" "\$AUTHZ_DB_PASSWORD" "\$AUTHZ_DB_NAME"

echo "Development VPS PostgreSQL is ready for Idnest containers."
REMOTE
chmod 600 "$remote_script"

[ -t 0 ] || fail "run from an interactive terminal so remote sudo can prompt"
ssh "${ssh_args[@]}" "$VPS_ADMIN_USER@$VPS_HOST" \
  'install -d -m 700 "$HOME/idnest-postgres-setup"'
scp "${scp_args[@]}" "$remote_script" "$VPS_ADMIN_USER@$VPS_HOST:$remote_script_path"
ssh -tt "${ssh_args[@]}" "$VPS_ADMIN_USER@$VPS_HOST" \
  "bash '$remote_script_path'; status=\$?; rm -f -- '$remote_script_path'; exit \$status"

trap - EXIT HUP INT TERM
cleanup
