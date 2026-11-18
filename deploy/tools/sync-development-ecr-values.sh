#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH='' cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd "$SCRIPT_DIR/../.." && pwd)

fail() {
  echo "Development ECR sync failed: $*" >&2
  exit 1
}

if [ "$#" -gt 2 ]; then
  fail "usage: sync-development-ecr-values.sh [TERRAFORM_DIRECTORY] [DEVELOPMENT_ENV_FILE]"
fi

terraform_directory=${1:-$REPO_ROOT/deploy/terraform/aws-development}
development_env=${2:-$REPO_ROOT/tmp/development.env}

for command in awk chmod grep jq mktemp mv rm terraform; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
[ -d "$terraform_directory" ] || fail "Terraform directory not found: $terraform_directory"
if [ ! -f "$development_env" ] || [ -L "$development_env" ] || [ ! -s "$development_env" ]; then
  fail "development environment must be a non-empty regular file: $development_env"
fi

registry=$(terraform -chdir="$terraform_directory" output -raw ecr_public_registry) \
  || fail "Terraform ECR Public registry output is unavailable; apply the reviewed plan first"
repositories=$(terraform -chdir="$terraform_directory" output -json ecr_repositories) \
  || fail "Terraform ECR repository output is unavailable; apply the reviewed plan first"

auth_repository=$(printf '%s' "$repositories" | jq -er '.auth | select(type == "string" and length > 0)') \
  || fail "Terraform output does not contain a valid auth repository"
admin_repository=$(printf '%s' "$repositories" | jq -er '.admin | select(type == "string" and length > 0)') \
  || fail "Terraform output does not contain a valid admin repository"

printf '%s\n' "$registry" | grep -Eq '^public\.ecr\.aws/[a-z0-9][a-z0-9._-]*$' \
  || fail "Terraform returned an invalid ECR Public registry"
for repository in "$auth_repository" "$admin_repository"; do
  printf '%s\n' "$repository" | grep -Eq '^[a-z0-9][a-z0-9._/-]*$' \
    || fail "Terraform returned an invalid ECR Public repository: $repository"
done

skip_count=$(awk '
  /^[[:space:]]*SKIP_PUBLIC_HEALTH_CHECK[[:space:]]*=/ { count++ }
  END { print count + 0 }
' "$development_env")
[ "$skip_count" -le 1 ] || fail "development environment contains duplicate SKIP_PUBLIC_HEALTH_CHECK keys"

skip_public_health_check=$(awk '
  /^[[:space:]]*SKIP_PUBLIC_HEALTH_CHECK[[:space:]]*=/ {
    value = $0
    sub(/^[^=]*=/, "", value)
    sub(/^[[:space:]]*/, "", value)
    sub(/[[:space:]]*$/, "", value)
    if (value ~ /^".*"$/ || value ~ /^\047.*\047$/) {
      value = substr(value, 2, length(value) - 2)
    }
    print value
    exit
  }
' "$development_env")
skip_public_health_check=${skip_public_health_check:-false}
case "$skip_public_health_check" in
  true|false) ;;
  *) fail "SKIP_PUBLIC_HEALTH_CHECK must be true or false" ;;
esac

development_directory=${development_env%/*}
[ "$development_directory" != "$development_env" ] || development_directory=.
if [ ! -d "$development_directory" ] || [ -L "$development_directory" ]; then
  fail "development environment directory must be a regular directory"
fi

umask 077
candidate=$(mktemp "$development_directory/.development.env.XXXXXX")
cleanup() {
  rm -f -- "$candidate"
}
trap cleanup EXIT HUP INT TERM

awk \
  -v registry="$registry" \
  -v auth_repository="$auth_repository" \
  -v admin_repository="$admin_repository" \
  -v skip_public_health_check="$skip_public_health_check" '
  BEGIN {
    values["ECR_PUBLIC_REGISTRY"] = registry
    values["AUTH_ECR_REPOSITORY"] = auth_repository
    values["ADMIN_ECR_REPOSITORY"] = admin_repository
    values["SKIP_PUBLIC_HEALTH_CHECK"] = skip_public_health_check
    order[1] = "ECR_PUBLIC_REGISTRY"
    order[2] = "AUTH_ECR_REPOSITORY"
    order[3] = "ADMIN_ECR_REPOSITORY"
    order[4] = "SKIP_PUBLIC_HEALTH_CHECK"
  }
  /^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/ {
    key = $0
    sub(/^[[:space:]]*/, "", key)
    sub(/[[:space:]]*=.*/, "", key)
    if (key in values) {
      if (!(key in written)) print key "=" values[key]
      written[key] = 1
      next
    }
  }
  { print }
  END {
    for (idx = 1; idx <= 4; idx++) {
      key = order[idx]
      if (!(key in written)) print key "=" values[key]
    }
  }
' "$development_env" >"$candidate"

chmod 600 "$candidate"
mv -- "$candidate" "$development_env"
candidate=
trap - EXIT HUP INT TERM

echo "Synchronized Terraform ECR values to $development_env."
echo "Preserved SKIP_PUBLIC_HEALTH_CHECK=$skip_public_health_check and all unrelated values."
