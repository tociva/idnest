#!/bin/sh
set -eu

fail() {
  echo "Development environment Terraform sync failed: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/deploy/update-development-env-from-terraform.sh [DEVELOPMENT_ENV] [TERRAFORM_DIRECTORY]

Atomically imports the non-secret AWS and VPS values from Terraform state into
the protected combined development environment file.

Defaults:
  DEVELOPMENT_ENV=tmp/development.env
  TERRAFORM_DIRECTORY=infrastructure/terraform/aws-development
EOF
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
esac
[ "$#" -le 2 ] || { usage >&2; exit 2; }

for command in awk chmod dirname install mktemp mv rm stat uname; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd "$SCRIPT_DIR/../.." && pwd)
DEVELOPMENT_ENV=${1:-$REPO_ROOT/tmp/development.env}
TERRAFORM_DIRECTORY=${2:-$REPO_ROOT/infrastructure/terraform/aws-development}

for helper in \
  "$SCRIPT_DIR/render-github-environment-vars.sh" \
  "$SCRIPT_DIR/vps/validate-app-env.sh"; do
  [ -f "$helper" ] && [ ! -L "$helper" ] && [ -x "$helper" ] \
    || fail "missing or invalid helper: $helper"
done

file_mode() {
  if [ "$(uname -s)" = Darwin ]; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

development_directory=$(dirname "$DEVELOPMENT_ENV")
if [ -e "$development_directory" ] || [ -L "$development_directory" ]; then
  [ -d "$development_directory" ] && [ ! -L "$development_directory" ] \
    || fail "development input directory is invalid: $development_directory"
else
  install -d -m 700 "$development_directory" \
    || fail "could not create protected input directory: $development_directory"
fi

if [ ! -e "$DEVELOPMENT_ENV" ] && [ ! -L "$DEVELOPMENT_ENV" ]; then
  generator=$SCRIPT_DIR/create-development-env.sh
  [ -f "$generator" ] && [ ! -L "$generator" ] && [ -x "$generator" ] \
    || fail "missing or invalid generator: $generator"
  "$generator" "$DEVELOPMENT_ENV" "$TERRAFORM_DIRECTORY" >/dev/null
  fail "created $DEVELOPMENT_ENV; replace its manual placeholders, then rerun this sync"
fi

[ -f "$DEVELOPMENT_ENV" ] && [ ! -L "$DEVELOPMENT_ENV" ] && [ -s "$DEVELOPMENT_ENV" ] \
  || fail "development environment must be a non-empty regular file: $DEVELOPMENT_ENV"
[ "$(file_mode "$DEVELOPMENT_ENV")" = 600 ] \
  || fail "development environment file must have mode 600: $DEVELOPMENT_ENV"
[ -d "$TERRAFORM_DIRECTORY" ] && [ ! -L "$TERRAFORM_DIRECTORY" ] \
  || fail "Terraform directory is missing or invalid: $TERRAFORM_DIRECTORY"

temporary_parent=${TMPDIR:-/tmp}
temporary_parent=${temporary_parent%/}
RENDERED_DIRECTORY=$(mktemp -d "$temporary_parent/idnest-terraform-vars.XXXXXX")
UPDATES_FILE=$(mktemp "$temporary_parent/idnest-development-infra.XXXXXX")
MERGED_FILE=$(mktemp "$development_directory/.idnest-development-env.XXXXXX")
cleanup() {
  rm -f -- "${UPDATES_FILE:-}" "${MERGED_FILE:-}"
  case "${RENDERED_DIRECTORY:-}" in
    "$temporary_parent"/idnest-terraform-vars.*)
      [ ! -L "$RENDERED_DIRECTORY" ] && rm -rf -- "$RENDERED_DIRECTORY"
      ;;
  esac
}
trap cleanup EXIT HUP INT TERM
chmod 700 "$RENDERED_DIRECTORY"
chmod 600 "$UPDATES_FILE" "$MERGED_FILE"

"$SCRIPT_DIR/render-github-environment-vars.sh" \
  "$TERRAFORM_DIRECTORY" \
  "$RENDERED_DIRECTORY"

dotenv_value() {
  source_file=$1
  wanted_key=$2
  awk -v wanted="$wanted_key" '
    index($0, "=") > 0 {
      key = substr($0, 1, index($0, "=") - 1)
      if (key == wanted) {
        print substr($0, index($0, "=") + 1)
        exit
      }
    }
  ' "$source_file"
}

ecr_file=$RENDERED_DIRECTORY/ecr-build.vars.env
auth_file=$RENDERED_DIRECTORY/development-auth.vars.env
admin_file=$RENDERED_DIRECTORY/development-admin.vars.env
identity_file=$RENDERED_DIRECTORY/development-identity.vars.env

AWS_ACCOUNT_ID=$(dotenv_value "$ecr_file" AWS_ACCOUNT_ID)
AWS_REGION=$(dotenv_value "$ecr_file" AWS_REGION)
AWS_BUILD_ROLE_ARN=$(dotenv_value "$ecr_file" AWS_BUILD_ROLE_ARN)
AUTH_AWS_DEPLOY_ROLE_ARN=$(dotenv_value "$auth_file" AWS_DEPLOY_ROLE_ARN)
ADMIN_AWS_DEPLOY_ROLE_ARN=$(dotenv_value "$admin_file" AWS_DEPLOY_ROLE_ARN)
AUTH_ECR_REPOSITORY=$(dotenv_value "$ecr_file" AUTH_ECR_REPOSITORY)
ADMIN_ECR_REPOSITORY=$(dotenv_value "$ecr_file" ADMIN_ECR_REPOSITORY)
BUILDER_ECR_REPOSITORY=$(dotenv_value "$ecr_file" BUILDER_ECR_REPOSITORY)
VPS_HOST=$(dotenv_value "$identity_file" VPS_HOST)
VPS_PORT=$(dotenv_value "$identity_file" VPS_PORT)
VPS_USER=$(dotenv_value "$identity_file" VPS_USER)

require_same() {
  label=$1
  expected=$2
  actual=$3
  [ "$actual" = "$expected" ] \
    || fail "Terraform environments disagree about $label"
}

require_same AWS_ACCOUNT_ID "$AWS_ACCOUNT_ID" "$(dotenv_value "$auth_file" AWS_ACCOUNT_ID)"
require_same AWS_ACCOUNT_ID "$AWS_ACCOUNT_ID" "$(dotenv_value "$admin_file" AWS_ACCOUNT_ID)"
require_same AWS_REGION "$AWS_REGION" "$(dotenv_value "$auth_file" AWS_REGION)"
require_same AWS_REGION "$AWS_REGION" "$(dotenv_value "$admin_file" AWS_REGION)"
require_same AUTH_ECR_REPOSITORY "$AUTH_ECR_REPOSITORY" "$(dotenv_value "$auth_file" ECR_REPOSITORY)"
require_same ADMIN_ECR_REPOSITORY "$ADMIN_ECR_REPOSITORY" "$(dotenv_value "$admin_file" ECR_REPOSITORY)"
for deployment_file in "$auth_file" "$admin_file"; do
  require_same VPS_HOST "$VPS_HOST" "$(dotenv_value "$deployment_file" VPS_HOST)"
  require_same VPS_PORT "$VPS_PORT" "$(dotenv_value "$deployment_file" VPS_PORT)"
  require_same VPS_USER "$VPS_USER" "$(dotenv_value "$deployment_file" VPS_USER)"
done

{
  printf 'AWS_ACCOUNT_ID=%s\n' "$AWS_ACCOUNT_ID"
  printf 'AWS_REGION=%s\n' "$AWS_REGION"
  printf 'AWS_BUILD_ROLE_ARN=%s\n' "$AWS_BUILD_ROLE_ARN"
  printf 'AUTH_AWS_DEPLOY_ROLE_ARN=%s\n' "$AUTH_AWS_DEPLOY_ROLE_ARN"
  printf 'ADMIN_AWS_DEPLOY_ROLE_ARN=%s\n' "$ADMIN_AWS_DEPLOY_ROLE_ARN"
  printf 'AUTH_ECR_REPOSITORY=%s\n' "$AUTH_ECR_REPOSITORY"
  printf 'ADMIN_ECR_REPOSITORY=%s\n' "$ADMIN_ECR_REPOSITORY"
  printf 'BUILDER_ECR_REPOSITORY=%s\n' "$BUILDER_ECR_REPOSITORY"
  printf 'VPS_HOST=%s\n' "$VPS_HOST"
  printf 'VPS_PORT=%s\n' "$VPS_PORT"
  printf 'VPS_USER=%s\n' "$VPS_USER"
} >"$UPDATES_FILE"

awk '
  NR == FNR {
    separator = index($0, "=")
    key = substr($0, 1, separator - 1)
    values[key] = substr($0, separator + 1)
    order[++update_count] = key
    next
  }
  {
    separator = index($0, "=")
    key = separator > 0 ? substr($0, 1, separator - 1) : ""
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
    if (!(key in values)) source[++source_count] = $0
  }
  END {
    for (idx = 1; idx <= update_count; idx++) {
      key = order[idx]
      print key "=" values[key]
    }
    if (source_count > 0 && length(source[1]) > 0) print ""
    for (idx = 1; idx <= source_count; idx++) print source[idx]
  }
' "$UPDATES_FILE" "$DEVELOPMENT_ENV" >"$MERGED_FILE"
chmod 600 "$MERGED_FILE"

"$SCRIPT_DIR/vps/validate-app-env.sh" "$MERGED_FILE" development-source >/dev/null \
  || fail "the merged file was not installed; correct the protected application values and retry"

mv "$MERGED_FILE" "$DEVELOPMENT_ENV"
MERGED_FILE=
cleanup
RENDERED_DIRECTORY=
UPDATES_FILE=
trap - EXIT HUP INT TERM
echo "Updated $DEVELOPMENT_ENV from validated Terraform state without printing values."
