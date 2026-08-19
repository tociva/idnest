#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "GitHub variable rendering failed: $*" >&2
  exit 1
}

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 TERRAFORM_DIRECTORY OUTPUT_DIRECTORY" >&2
  exit 2
fi

terraform_directory=$1
output_directory=$2

[ -d "$terraform_directory" ] && [ ! -L "$terraform_directory" ] \
  || fail "Terraform directory must be a regular directory: $terraform_directory"
for command in chmod install jq mktemp mv rm terraform; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

if [ -e "$output_directory" ]; then
  [ -d "$output_directory" ] && [ ! -L "$output_directory" ] \
    || fail "output directory must not be a symbolic link: $output_directory"
else
  install -d -m 700 "$output_directory"
fi
chmod 700 "$output_directory"

json_file=$(mktemp "${TMPDIR:-/tmp}/idnest-github-vars.XXXXXX")
current_output=
cleanup() {
  rm -f -- "$json_file"
  [ -z "$current_output" ] || rm -f -- "$current_output"
}
trap cleanup EXIT

terraform -chdir="$terraform_directory" output -json github_environment_variables >"$json_file"
jq -e 'type == "object"' "$json_file" >/dev/null \
  || fail "Terraform output github_environment_variables must be an object"
actual_environments=$(jq -r 'keys | sort | join(" ")' "$json_file")
expected_environments="development-admin development-auth development-identity ecr-build"
[ "$actual_environments" = "$expected_environments" ] \
  || fail "Terraform state must contain exactly the four development GitHub environments (actual: ${actual_environments:-none}). Run terraform apply in $terraform_directory, then retry"

expected_keys() {
  case "$1" in
    ecr-build)
      printf '%s\n' "ADMIN_ECR_REPOSITORY AUTH_ECR_REPOSITORY AWS_ACCOUNT_ID AWS_BUILD_ROLE_ARN AWS_REGION BUILDER_ECR_REPOSITORY"
      ;;
    development-auth|development-admin)
      printf '%s\n' "AWS_ACCOUNT_ID AWS_DEPLOY_ROLE_ARN AWS_REGION ECR_REPOSITORY VPS_HOST VPS_PORT VPS_USER"
      ;;
    development-identity)
      printf '%s\n' "VPS_HOST VPS_PORT VPS_USER"
      ;;
    *) fail "unsupported GitHub environment: $1" ;;
  esac
}

validate_value() {
  key=$1
  value=$2
  [ -n "$value" ] || fail "$key has an empty value"
  case "$value" in
    *replace-with*|*.example.com|*.example.com:*|*$'\r'*)
      fail "$key still contains a placeholder or invalid control character"
      ;;
  esac
  case "$key" in
    AWS_ACCOUNT_ID)
      [[ "$value" =~ ^[0-9]{12}$ ]] || fail "$key must be a 12-digit AWS account ID"
      ;;
    AWS_REGION)
      [[ "$value" =~ ^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$ ]] || fail "$key is not a valid AWS region"
      ;;
    AWS_BUILD_ROLE_ARN|AWS_DEPLOY_ROLE_ARN)
      [[ "$value" =~ ^arn:aws:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$ ]] || fail "$key is not a valid IAM role ARN"
      ;;
    AUTH_ECR_REPOSITORY|ADMIN_ECR_REPOSITORY|BUILDER_ECR_REPOSITORY|ECR_REPOSITORY)
      [[ "$value" =~ ^[a-z0-9][a-z0-9._/-]*$ ]] || fail "$key is not a valid ECR repository name"
      ;;
    VPS_HOST)
      [[ "$value" =~ ^[A-Za-z0-9.-]+$ ]] || fail "$key is not a valid hostname or IP address"
      ;;
    VPS_PORT)
      [[ "$value" =~ ^[0-9]{1,5}$ ]] && [ "$value" -ge 1 ] && [ "$value" -le 65535 ] \
        || fail "$key is not a valid TCP port"
      ;;
    VPS_USER)
      [[ "$value" =~ ^[A-Za-z_][A-Za-z0-9._-]*$ ]] || fail "$key is not a valid SSH user"
      ;;
    *) fail "unexpected variable key: $key" ;;
  esac
}

environments=(ecr-build development-auth development-admin development-identity)
for environment in "${environments[@]}"; do
  jq -e --arg environment "$environment" '.[$environment] | type == "object"' "$json_file" >/dev/null \
    || fail "Terraform output is missing $environment"
  actual=$(jq -r --arg environment "$environment" '.[$environment] | keys | sort | join(" ")' "$json_file")
  expected=$(expected_keys "$environment")
  [ "$actual" = "$expected" ] \
    || fail "$environment has an unexpected variable set (expected: $expected; actual: $actual)"

  current_output=$(mktemp "$output_directory/.${environment}.vars.env.XXXXXX")
  while IFS='=' read -r key value; do
    validate_value "$key" "$value"
    printf '%s=%s\n' "$key" "$value" >>"$current_output"
  done < <(
    jq -r --arg environment "$environment" \
      '.[$environment] | to_entries | sort_by(.key)[] | "\(.key)=\(.value | tostring)"' \
      "$json_file"
  )
  chmod 600 "$current_output"
  mv "$current_output" "$output_directory/$environment.vars.env"
  current_output=
  echo "Rendered $output_directory/$environment.vars.env"
done

echo "Rendered four development GitHub environment variable files without secret values."
