#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deploy/ci/release-common.sh
. "$SCRIPT_DIR/release-common.sh"

echo "validate-release-inputs.sh version: 2026-09-01.1-apple-awk-warning-check"

usage() {
  cat <<'EOF'
Usage:
  scripts/deploy/ci/validate-release-inputs.sh app auth|admin
  scripts/deploy/ci/validate-release-inputs.sh identity
  scripts/deploy/ci/validate-release-inputs.sh rollback
  scripts/deploy/ci/validate-release-inputs.sh promotion
EOF
}

valid_vps_config() {
  require_env VPS_HOST
  require_env VPS_USER
  local port="${VPS_PORT:-22}"
  [[ "$VPS_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || fail "VPS_HOST is invalid"
  [[ "$port" =~ ^[0-9]{1,5}$ && "$port" -ge 1 && "$port" -le 65535 ]] || fail "VPS_PORT is invalid"
  [[ "$VPS_USER" =~ ^[A-Za-z_][A-Za-z0-9._-]*$ ]] || fail "VPS_USER is invalid"
  require_env VPS_SSH_PRIVATE_KEY_B64
  require_env VPS_SSH_KNOWN_HOSTS_B64
  require_env HOST_RELEASE_SIGNING_PRIVATE_KEY_B64
}

valid_aws_config() {
  require_env AWS_ACCOUNT_ID
  require_env AWS_REGION
  require_env AWS_DEPLOY_ROLE_ARN
  require_env ECR_REPOSITORY
  [[ "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]] || fail "AWS_ACCOUNT_ID is invalid"
  [[ "$AWS_REGION" =~ ^[a-z0-9-]+$ ]] || fail "AWS_REGION is invalid"
  [[ "$AWS_DEPLOY_ROLE_ARN" == arn:aws:iam::"$AWS_ACCOUNT_ID":role/* ]] \
    || fail "AWS_DEPLOY_ROLE_ARN is invalid"
  [[ "$ECR_REPOSITORY" =~ ^[a-z0-9][a-z0-9._/-]*$ ]] || fail "ECR_REPOSITORY is invalid"
}

valid_app_runtime_secrets() {
  local component=$1
  require_env AUTHZ_DATABASE_URL
  require_env ADMIN_BOOTSTRAP_EMAILS
  case "$component" in
    auth)
      require_env CONSENT_ACTION_SECRET
      require_env AUTH_TRANSACTION_SECRET
      require_env AUTH_AUDIT_HASH_SECRET
      require_env DELEGATION_ENABLED
      require_env DELEGATION_SIGNING_PRIVATE_KEY_B64
      [[ "$DELEGATION_ENABLED" == true || "$DELEGATION_ENABLED" == false ]] \
        || fail "DELEGATION_ENABLED must be true or false"
      ;;
    admin)
      require_env ADMIN_CSRF_SECRET
      require_env ADMIN_OIDC_CLIENT_SECRET
      ;;
  esac
}

mode=${1:-}
case "$mode" in
  app)
    [[ "$#" -eq 2 ]] || { usage >&2; exit 2; }
    component=$2
    valid_component "$component" || fail "component must be auth or admin"
    require_env IMAGE_DIGEST
    require_env REVISION
    [[ "$IMAGE_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "IMAGE_DIGEST is invalid"
    [[ "$REVISION" =~ ^[a-f0-9]{40}$ ]] || fail "REVISION is invalid"
    valid_aws_config
    valid_vps_config
    valid_app_runtime_secrets "$component"
    ;;
  identity)
    [[ "$#" -eq 1 ]] || { usage >&2; exit 2; }
    [[ "${GITHUB_SHA:-}" =~ ^[a-f0-9]{40}$ ]] || fail "GITHUB_SHA is invalid"
    valid_vps_config
    require_env GOOGLE_CLIENT_ID
    require_env GOOGLE_CLIENT_SECRET
    require_env HYDRA_DSN
    require_env HYDRA_SECRETS_SYSTEM
    require_env KRATOS_DSN
    require_env KRATOS_CSRF_COOKIE_SECRET
    require_env KRATOS_CIPHER_SECRET
    apple_count=0
    for value in "${APPLE_CLIENT_ID:-}" "${APPLE_TEAM_ID:-}" "${APPLE_PRIVATE_KEY_ID:-}" "${APPLE_PRIVATE_KEY_B64:-}"; do
      [[ -z "$value" ]] || apple_count=$((apple_count + 1))
    done
    [[ "$apple_count" == 0 || "$apple_count" == 4 ]] || fail "Apple login variables must be empty or complete"
    bash -n "$REPO_ROOT/scripts/deploy/render-development-identity-env.sh"
    bash "$REPO_ROOT/scripts/deploy/test-cors-contract.sh"
    bash "$REPO_ROOT/scripts/ci/test-deployment-contracts.sh"
    ;;
  rollback)
    [[ "$#" -eq 1 ]] || { usage >&2; exit 2; }
    require_env COMPONENT
    require_env VERSION
    component="${COMPONENT:-}"
    valid_component "$component" || fail "COMPONENT must be auth or admin"
    [[ "$VERSION" =~ ^sha256:[a-f0-9]{64}$ || "$VERSION" =~ ^git-[a-f0-9]{40}-[1-9][0-9]*-[1-9][0-9]*$ ]] \
      || fail "VERSION is invalid"
    valid_aws_config
    valid_vps_config
    valid_app_runtime_secrets "$component"
    bash -n "$REPO_ROOT/scripts/deploy/resolve-development-rollback-image.sh"
    bash -n "$REPO_ROOT/scripts/deploy/render-development-app-env.sh"
    bash "$REPO_ROOT/scripts/ci/test-deployment-contracts.sh"
    ;;
  promotion)
    [[ "$#" -eq 1 ]] || { usage >&2; exit 2; }
    require_env COMPONENT
    require_env IMAGE_DIGEST
    require_env REVISION
    valid_component "$COMPONENT" || fail "COMPONENT must be auth or admin"
    [[ "$IMAGE_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "IMAGE_DIGEST is invalid"
    [[ "$REVISION" =~ ^[a-f0-9]{40}$ ]] || fail "REVISION is invalid"
    valid_aws_config
    valid_vps_config
    ;;
  -h|--help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
