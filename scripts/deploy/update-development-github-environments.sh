#!/bin/sh
set -eu

fail() {
  echo "Development GitHub Environment update failed: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/deploy/update-development-github-environments.sh [OWNER/REPOSITORY] [IDNEST_ENV]

Bulk-creates or updates variables and secrets for ecr-build,
development-auth, development-admin, and development-identity.

Defaults:
  OWNER/REPOSITORY=tociva/idnest
  IDNEST_ENV=tmp/vps.env when present, otherwise ../idnest-secure/idnest.env

The deployment keys and auth/admin source files are read from ../idnest-secure.
Prepared dotenv files are kept in a mode-0700 temporary directory and removed
after success or failure.
EOF
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
esac
[ "$#" -le 2 ] || { usage >&2; exit 2; }

GITHUB_REPOSITORY=${1:-tociva/idnest}
printf '%s\n' "$GITHUB_REPOSITORY" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' \
  || fail "repository must use OWNER/REPOSITORY form"

for command in chmod dirname gh grep mktemp rm; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
gh auth status >/dev/null || fail "GitHub CLI authentication is required"

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd "$SCRIPT_DIR/../.." && pwd)
REPO_PARENT=$(CDPATH= cd "$REPO_ROOT/.." && pwd)
DEPLOY_KEYS_DIR=$REPO_PARENT/idnest-secure
TERRAFORM_DIRECTORY=$REPO_ROOT/infrastructure/terraform/aws-development

if [ "$#" -eq 2 ]; then
  IDNEST_ENV=$2
elif [ -f "$REPO_ROOT/tmp/vps.env" ] && [ ! -L "$REPO_ROOT/tmp/vps.env" ]; then
  IDNEST_ENV=$REPO_ROOT/tmp/vps.env
else
  IDNEST_ENV=$DEPLOY_KEYS_DIR/idnest.env
fi

for required_file in \
  "$DEPLOY_KEYS_DIR/github-deploy-ed25519" \
  "$DEPLOY_KEYS_DIR/vps-known-hosts" \
  "$DEPLOY_KEYS_DIR/host-release-signing-private.pem" \
  "$DEPLOY_KEYS_DIR/auth-app.env" \
  "$DEPLOY_KEYS_DIR/admin-app.env" \
  "$IDNEST_ENV"; do
  [ -f "$required_file" ] && [ ! -L "$required_file" ] && [ -s "$required_file" ] \
    || fail "missing or invalid protected input: $required_file"
done

for helper in \
  "$SCRIPT_DIR/render-github-environment-vars.sh" \
  "$SCRIPT_DIR/prepare-github-environments.sh" \
  "$SCRIPT_DIR/configure-github-environments.sh"; do
  [ -f "$helper" ] && [ ! -L "$helper" ] && [ -x "$helper" ] \
    || fail "missing or invalid helper: $helper"
done

umask 077
temporary_parent=${TMPDIR:-/tmp}
temporary_parent=${temporary_parent%/}
PREPARED_DIRECTORY=$(mktemp -d "$temporary_parent/idnest-github-environments.XXXXXX")
cleanup() {
  case "${PREPARED_DIRECTORY:-}" in
    "$temporary_parent"/idnest-github-environments.*)
      [ ! -L "$PREPARED_DIRECTORY" ] && rm -rf -- "$PREPARED_DIRECTORY"
      ;;
  esac
}
trap cleanup EXIT HUP INT TERM
chmod 700 "$PREPARED_DIRECTORY"

"$SCRIPT_DIR/render-github-environment-vars.sh" \
  "$TERRAFORM_DIRECTORY" \
  "$PREPARED_DIRECTORY"

"$SCRIPT_DIR/prepare-github-environments.sh" \
  "$DEPLOY_KEYS_DIR/github-deploy-ed25519" \
  "$DEPLOY_KEYS_DIR/vps-known-hosts" \
  "$DEPLOY_KEYS_DIR/host-release-signing-private.pem" \
  "$DEPLOY_KEYS_DIR/auth-app.env" \
  "$DEPLOY_KEYS_DIR/admin-app.env" \
  "$IDNEST_ENV" \
  "$PREPARED_DIRECTORY"

"$SCRIPT_DIR/configure-github-environments.sh" \
  "$GITHUB_REPOSITORY" \
  "$PREPARED_DIRECTORY"

cleanup
PREPARED_DIRECTORY=
trap - EXIT HUP INT TERM
echo "Updated all development GitHub Environment variables and secrets for $GITHUB_REPOSITORY."
