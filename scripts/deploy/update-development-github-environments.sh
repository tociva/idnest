#!/bin/sh
set -eu

fail() {
  echo "Development GitHub Environment update failed: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/deploy/update-development-github-environments.sh [OWNER/REPOSITORY] [DEVELOPMENT_ENV]

Bulk-creates or updates variables and secrets for ecr-build,
development-auth, development-admin, and development-identity.

Defaults:
  OWNER/REPOSITORY=tociva/idnest
  DEVELOPMENT_ENV=tmp/development.env

All configurable auth, admin, Hydra, Kratos, Google, and optional Apple values
are read from that single protected development environment file. Deployment
SSH and release-signing keys remain separate files under ../idnest-secure.
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

for command in chmod dirname gh grep install mktemp rm; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd "$SCRIPT_DIR/../.." && pwd)
REPO_PARENT=$(CDPATH= cd "$REPO_ROOT/.." && pwd)
DEPLOY_KEYS_DIR=$REPO_PARENT/idnest-secure
TERRAFORM_DIRECTORY=$REPO_ROOT/infrastructure/terraform/aws-development
[ -d "$DEPLOY_KEYS_DIR" ] && [ ! -L "$DEPLOY_KEYS_DIR" ] \
  || fail "protected directory is missing or invalid: $DEPLOY_KEYS_DIR (run create-development-credentials.sh first)"

if [ "$#" -eq 2 ]; then
  DEVELOPMENT_ENV=$2
else
  DEVELOPMENT_ENV=$REPO_ROOT/tmp/development.env
fi

umask 077
if [ "$DEVELOPMENT_ENV" = "$REPO_ROOT/tmp/development.env" ] \
  && [ ! -e "$DEVELOPMENT_ENV" ] && [ ! -L "$DEVELOPMENT_ENV" ]; then
  development_directory=$REPO_ROOT/tmp
  if [ -e "$development_directory" ] || [ -L "$development_directory" ]; then
    [ -d "$development_directory" ] && [ ! -L "$development_directory" ] \
      || fail "development input directory is invalid: $development_directory"
  else
    install -d -m 700 "$development_directory" \
      || fail "could not create protected input directory: $development_directory"
  fi
  template=$SCRIPT_DIR/env/development.env.example
  [ -f "$template" ] && [ ! -L "$template" ] && [ -s "$template" ] \
    || fail "missing or invalid tracked template: $template"
  install -m 600 "$template" "$DEVELOPMENT_ENV" \
    || fail "could not create protected source: $DEVELOPMENT_ENV"
  fail "created $DEVELOPMENT_ENV; replace its placeholders and rerun this updater"
fi

for required_file in \
  "$DEPLOY_KEYS_DIR/github-deploy-ed25519" \
  "$DEPLOY_KEYS_DIR/vps-known-hosts" \
  "$DEPLOY_KEYS_DIR/host-release-signing-private.pem" \
  "$DEVELOPMENT_ENV"; do
  [ -f "$required_file" ] && [ ! -L "$required_file" ] && [ -s "$required_file" ] \
    || fail "missing or invalid protected input: $required_file"
done

for helper in \
  "$SCRIPT_DIR/render-github-environment-vars.sh" \
  "$SCRIPT_DIR/prepare-github-environments.sh" \
  "$SCRIPT_DIR/configure-github-environments.sh" \
  "$SCRIPT_DIR/vps/validate-app-env.sh"; do
  [ -f "$helper" ] && [ ! -L "$helper" ] && [ -x "$helper" ] \
    || fail "missing or invalid helper: $helper"
done

"$SCRIPT_DIR/vps/validate-app-env.sh" "$DEVELOPMENT_ENV" development-source >/dev/null
gh auth status >/dev/null || fail "GitHub CLI authentication is required"

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
  "$DEVELOPMENT_ENV" \
  "$PREPARED_DIRECTORY"

"$SCRIPT_DIR/configure-github-environments.sh" \
  "$GITHUB_REPOSITORY" \
  "$PREPARED_DIRECTORY"

cleanup
PREPARED_DIRECTORY=
trap - EXIT HUP INT TERM
echo "Updated all development GitHub Environment variables and secrets for $GITHUB_REPOSITORY."
