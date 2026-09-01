#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deploy/ci/release-common.sh
. "$SCRIPT_DIR/release-common.sh"

[[ "$#" -eq 0 ]] || fail "usage: scripts/deploy/ci/cleanup-release-request.sh"

temp="$(runner_temp)"
rm -f -- \
  "$temp/app.env" \
  "$temp/app-env.sig" \
  "$temp/idnest.env" \
  "$temp/idnest-env.sig" \
  "$temp/idnest-config.tar.gz" \
  "$temp/idnest-config.sig" \
  "$temp/host-release.tar.gz" \
  "$temp/host-release.sig" \
  "$temp/host-release-signing-private.pem" \
  "$temp/ecr-password" \
  "$temp/rollback-image.env" \
  "$temp/release-inputs.txt" \
  "$temp/idnest-ssh/id_ed25519" \
  "$temp/idnest-ssh/known_hosts"
