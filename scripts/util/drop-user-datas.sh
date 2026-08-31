#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$PWD"
. "$REPO_ROOT/scripts/setup/load-project-env.sh"
load_project_env "$REPO_ROOT"
derive_database_env

case "${KRATOS_ADMIN_URL%/}" in
  http://localhost:*|http://127.0.0.1:*) ;;
  *) echo "Refusing non-local KRATOS_ADMIN_URL: $KRATOS_ADMIN_URL" >&2; exit 1 ;;
esac

case "${HYDRA_ADMIN_URL%/}" in
  http://localhost:*|http://127.0.0.1:*) ;;
  *) echo "Refusing non-local HYDRA_ADMIN_URL: $HYDRA_ADMIN_URL" >&2; exit 1 ;;
esac

AUTHZ_HOST="$(node -e 'process.stdout.write(new URL(process.argv[1]).hostname)' "$AUTHZ_DATABASE_URL")"
case "$AUTHZ_HOST" in
  localhost|127.0.0.1|::1) ;;
  *) echo "Refusing non-local Authz database: $AUTHZ_HOST" >&2; exit 1 ;;
esac

echo "Deleting Kratos identities and revoking Hydra sessions..."

while :; do
  IDENTITIES="$(
    curl -fsS "${KRATOS_ADMIN_URL%/}/admin/identities?page_size=250"
  )"

  IDS="$(printf '%s' "$IDENTITIES" | jq -er '
    if type == "array" then .[].id
    else error("Unexpected Kratos response")
    end
  ' || true)"

  [ -n "$IDS" ] || break

  printf '%s\n' "$IDS" | while IFS= read -r ID; do
    curl -fsS -o /dev/null -X DELETE -G \
      --data-urlencode "subject=$ID" \
      --data-urlencode "all=true" \
      "${HYDRA_ADMIN_URL%/}/admin/oauth2/auth/sessions/consent"

    curl -fsS -o /dev/null -X DELETE -G \
      --data-urlencode "subject=$ID" \
      "${HYDRA_ADMIN_URL%/}/admin/oauth2/auth/sessions/login"

    curl -fsS -o /dev/null -X DELETE \
      "${KRATOS_ADMIN_URL%/}/admin/identities/$ID"

    echo "Deleted identity $ID"
  done
done

echo "Clearing user-specific Authz data..."

psql "$AUTHZ_DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -v schema="$AUTHZ_DB_SCHEMA" <<'SQL'
SET search_path TO :"schema", public;

TRUNCATE TABLE
  admin_sessions,
  admin_oauth_transactions,
  client_access_grants,
  consent_approvals,
  consent_audit_events,
  delegation_audit_events,
  delegation_grants,
  auth_consent_transactions,
  auth_transactions,
  auth_audit_events;
SQL

echo "User-related server data cleared."
echo "Use a private browser window or clear *.idnest.cloud site data before testing."
