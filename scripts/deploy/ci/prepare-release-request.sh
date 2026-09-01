#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deploy/ci/release-common.sh
. "$SCRIPT_DIR/release-common.sh"

usage() {
  cat <<'EOF'
Usage:
  scripts/deploy/ci/prepare-release-request.sh app auth|admin
  scripts/deploy/ci/prepare-release-request.sh identity
  scripts/deploy/ci/prepare-release-request.sh promotion auth|admin

Creates the runner-side release artifacts expected by the VPS release queue:
SSH key material, signed host-release archive, component environment files, and
ECR password when the release deploys an application image.
EOF
}

mode=${1:-}
case "$mode" in
  app)
    [[ "$#" -eq 2 ]] || { usage >&2; exit 2; }
    component=$2
    valid_component "$component" || fail "component must be auth or admin"
    require_env AWS_REGION
    prepare_ssh_and_signing_key
    temp="$(runner_temp)"
    "$REPO_ROOT/scripts/deploy/render-development-app-env.sh" "$component" "$temp/app.env"
    create_archive_from_manifest "$HOST_RELEASE_MANIFEST" "$temp/host-release.tar.gz"
    sign_file "$temp/host-release.tar.gz" "$temp/host-release.sig"
    sign_file "$temp/app.env" "$temp/app-env.sig"
    aws ecr get-login-password --region "$AWS_REGION" >"$temp/ecr-password"
    chmod 600 "$temp/app.env" "$temp/app-env.sig" "$temp/host-release.tar.gz" \
      "$temp/host-release.sig" "$temp/ecr-password"
    write_release_inputs host-release.tar.gz host-release.sig app.env app-env.sig ecr-password
    ;;
  identity)
    [[ "$#" -eq 1 ]] || { usage >&2; exit 2; }
    prepare_ssh_and_signing_key
    temp="$(runner_temp)"
    "$REPO_ROOT/scripts/deploy/render-development-identity-env.sh" "$temp/idnest.env"
    create_archive_from_manifest "$IDENTITY_CONFIG_MANIFEST" "$temp/idnest-config.tar.gz"
    create_archive_from_manifest "$HOST_RELEASE_MANIFEST" "$temp/host-release.tar.gz"
    sign_file "$temp/host-release.tar.gz" "$temp/host-release.sig"
    sign_file "$temp/idnest.env" "$temp/idnest-env.sig"
    sign_file "$temp/idnest-config.tar.gz" "$temp/idnest-config.sig"
    chmod 600 "$temp/idnest.env" "$temp/idnest-env.sig" "$temp/idnest-config.tar.gz" \
      "$temp/idnest-config.sig" "$temp/host-release.tar.gz" "$temp/host-release.sig"
    write_release_inputs host-release.tar.gz host-release.sig idnest.env idnest-env.sig \
      idnest-config.tar.gz idnest-config.sig
    ;;
  promotion)
    [[ "$#" -eq 2 ]] || { usage >&2; exit 2; }
    component=$2
    valid_component "$component" || fail "component must be auth or admin"
    require_env AWS_REGION
    prepare_ssh_and_signing_key
    temp="$(runner_temp)"
    create_archive_from_manifest "$HOST_RELEASE_MANIFEST" "$temp/host-release.tar.gz"
    sign_file "$temp/host-release.tar.gz" "$temp/host-release.sig"
    aws ecr get-login-password --region "$AWS_REGION" >"$temp/ecr-password"
    chmod 600 "$temp/host-release.tar.gz" "$temp/host-release.sig" "$temp/ecr-password"
    write_release_inputs host-release.tar.gz host-release.sig ecr-password
    ;;
  -h|--help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
