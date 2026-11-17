#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "GitHub ecr-build sync failed: $*" >&2
  exit 1
}

SCRIPT_DIR=$(CDPATH='' cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(CDPATH='' cd "$SCRIPT_DIR/../.." && pwd)
TERRAFORM_DIRECTORY=${1:-$REPO_ROOT/deploy/terraform/aws-development}
GITHUB_REPOSITORY=${2:-tociva/idnest}
ENVIRONMENT=ecr-build

for command in gh jq terraform; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
[[ -d "$TERRAFORM_DIRECTORY" ]] || fail "Terraform directory not found: $TERRAFORM_DIRECTORY"
[[ "$GITHUB_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] \
  || fail "repository must use owner/name form"

gh auth status >/dev/null 2>&1 || fail "GitHub CLI is not authenticated"
gh api "repos/$GITHUB_REPOSITORY" >/dev/null \
  || fail "cannot access GitHub repository: $GITHUB_REPOSITORY"

terraform_values=$(terraform -chdir="$TERRAFORM_DIRECTORY" output -json github_environment_variables) \
  || fail "Terraform output is unavailable; apply the reviewed plan first"

expected_keys=(
  AWS_ACCOUNT_ID
  AWS_BUILD_ROLE_ARN
  ECR_PUBLIC_REGION
  ECR_PUBLIC_REGISTRY
  AUTH_ECR_REPOSITORY
  ADMIN_ECR_REPOSITORY
  BUILDER_ECR_REPOSITORY
)

mapfile -t actual_keys < <(jq -r 'keys[]' <<<"$(jq -c '.["ecr-build"]' <<<"$terraform_values")" | sort)
mapfile -t sorted_expected < <(printf '%s\n' "${expected_keys[@]}" | sort)
[[ "${actual_keys[*]}" == "${sorted_expected[*]}" ]] \
  || fail "Terraform ecr-build output does not contain the exact expected variable set"

account_id=$(jq -r '.["ecr-build"].AWS_ACCOUNT_ID' <<<"$terraform_values")
role_arn=$(jq -r '.["ecr-build"].AWS_BUILD_ROLE_ARN' <<<"$terraform_values")
registry=$(jq -r '.["ecr-build"].ECR_PUBLIC_REGISTRY' <<<"$terraform_values")
[[ "$account_id" =~ ^[0-9]{12}$ ]] || fail "invalid AWS account ID in Terraform output"
[[ "$role_arn" == "arn:aws:iam::$account_id:role/"* ]] || fail "invalid build role ARN in Terraform output"
[[ "$registry" =~ ^public\.ecr\.aws/[a-z0-9][a-z0-9._-]*$ ]] \
  || fail "invalid ECR Public registry in Terraform output"
[[ $(jq -r '.["ecr-build"].ECR_PUBLIC_REGION' <<<"$terraform_values") == us-east-1 ]] \
  || fail "ECR Public region must be us-east-1"

gh api --method PUT "repos/$GITHUB_REPOSITORY/environments/$ENVIRONMENT" >/dev/null
for key in "${expected_keys[@]}"; do
  value=$(jq -r --arg key "$key" '.["ecr-build"][$key]' <<<"$terraform_values")
  [[ -n "$value" && "$value" != null ]] || fail "Terraform returned an empty value for $key"
  gh variable set "$key" --env "$ENVIRONMENT" --repo "$GITHUB_REPOSITORY" --body "$value"
done

echo "Synchronized ${#expected_keys[@]} non-secret variables to $GITHUB_REPOSITORY environment $ENVIRONMENT."
echo "No deployment environment, repository secret, or AWS resource was changed by this script."
