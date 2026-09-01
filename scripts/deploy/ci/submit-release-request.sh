#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deploy/ci/release-common.sh
. "$SCRIPT_DIR/release-common.sh"

usage() {
  cat <<'EOF'
Usage:
  scripts/deploy/ci/submit-release-request.sh app auth|admin
  scripts/deploy/ci/submit-release-request.sh identity
  scripts/deploy/ci/submit-release-request.sh promotion auth|admin

Submits the already uploaded release request to the VPS queue and waits for the
root-owned processor to finish.
EOF
}

mode=${1:-}
require_env VPS_HOST
require_env VPS_USER
temp="$(runner_temp)"
port="${VPS_PORT:-22}"
id="$(request_id)"
[[ "$VPS_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || fail "VPS_HOST must be a hostname or IP address"
[[ "$port" =~ ^[0-9]{1,5}$ && "$port" -ge 1 && "$port" -le 65535 ]] || fail "VPS_PORT is invalid"
[[ "$VPS_USER" =~ ^[A-Za-z_][A-Za-z0-9._-]*$ ]] || fail "VPS_USER is invalid"

ssh_args=(
  -i "$temp/idnest-ssh/id_ed25519"
  -p "$port"
  -o BatchMode=yes
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$temp/idnest-ssh/known_hosts"
)

case "$mode" in
  app)
    [[ "$#" -eq 2 ]] || { usage >&2; exit 2; }
    component=$2
    valid_component "$component" || fail "component must be auth or admin"
    require_env AWS_ACCOUNT_ID
    require_env AWS_REGION
    require_env ECR_REPOSITORY
    require_env IMAGE_DIGEST
    require_env REVISION
    [[ "$IMAGE_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "IMAGE_DIGEST is invalid"
    [[ "$REVISION" =~ ^[a-f0-9]{40}$ ]] || fail "REVISION must be a full lowercase Git SHA"
    image_ref="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPOSITORY@$IMAGE_DIGEST"
    host_bundle_sha256="$(sha256_file "$temp/host-release.tar.gz")"
    app_env_sha256="$(sha256_file "$temp/app.env")"
    ssh "${ssh_args[@]}" "$VPS_USER@$VPS_HOST" \
      /usr/local/bin/submit-idnest-release "$component" "$id" "$GITHUB_RUN_ID" \
      "$REVISION" "$image_ref" "$host_bundle_sha256" "$app_env_sha256"
    ssh "${ssh_args[@]}" "$VPS_USER@$VPS_HOST" \
      /usr/local/bin/wait-idnest-release "$component" "$id" 2200
    ;;
  identity)
    [[ "$#" -eq 1 ]] || { usage >&2; exit 2; }
    revision="${REVISION:-${GITHUB_SHA:-}}"
    [[ "$revision" =~ ^[a-f0-9]{40}$ ]] || fail "REVISION or GITHUB_SHA must be a full lowercase Git SHA"
    host_bundle_sha256="$(sha256_file "$temp/host-release.tar.gz")"
    identity_env_sha256="$(sha256_file "$temp/idnest.env")"
    identity_config_sha256="$(sha256_file "$temp/idnest-config.tar.gz")"
    ssh "${ssh_args[@]}" "$VPS_USER@$VPS_HOST" \
      /usr/local/bin/submit-idnest-release identity "$id" "$GITHUB_RUN_ID" \
      "$revision" "$host_bundle_sha256" "$identity_env_sha256" "$identity_config_sha256"
    ssh "${ssh_args[@]}" "$VPS_USER@$VPS_HOST" \
      /usr/local/bin/wait-idnest-release identity "$id" 2200
    ;;
  promotion)
    [[ "$#" -eq 2 ]] || { usage >&2; exit 2; }
    component=$2
    valid_component "$component" || fail "component must be auth or admin"
    require_env AWS_ACCOUNT_ID
    require_env AWS_REGION
    require_env ECR_REPOSITORY
    require_env IMAGE_DIGEST
    require_env REVISION
    [[ "$IMAGE_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "IMAGE_DIGEST is invalid"
    [[ "$REVISION" =~ ^[a-f0-9]{40}$ ]] || fail "REVISION must be a full lowercase Git SHA"
    image_ref="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPOSITORY@$IMAGE_DIGEST"
    host_bundle_sha256="$(sha256_file "$temp/host-release.tar.gz")"
    ssh "${ssh_args[@]}" "$VPS_USER@$VPS_HOST" \
      /usr/local/bin/submit-idnest-release "$component" "$id" "$GITHUB_RUN_ID" \
      "$REVISION" "$image_ref" "$host_bundle_sha256"
    ssh "${ssh_args[@]}" "$VPS_USER@$VPS_HOST" \
      /usr/local/bin/wait-idnest-release "$component" "$id" 2200
    ;;
  -h|--help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
