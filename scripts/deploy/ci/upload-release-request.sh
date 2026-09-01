#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deploy/ci/release-common.sh
. "$SCRIPT_DIR/release-common.sh"

[[ "$#" -eq 0 ]] || fail "usage: scripts/deploy/ci/upload-release-request.sh"

require_env VPS_HOST
require_env VPS_USER
temp="$(runner_temp)"
port="${VPS_PORT:-22}"
[[ "$VPS_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || fail "VPS_HOST must be a hostname or IP address"
[[ "$port" =~ ^[0-9]{1,5}$ && "$port" -ge 1 && "$port" -le 65535 ]] || fail "VPS_PORT is invalid"
[[ "$VPS_USER" =~ ^[A-Za-z_][A-Za-z0-9._-]*$ ]] || fail "VPS_USER is invalid"

scp_args=(
  -i "$temp/idnest-ssh/id_ed25519"
  -P "$port"
  -o BatchMode=yes
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$temp/idnest-ssh/known_hosts"
)

id="$(request_id)"
while IFS= read -r name; do
  [[ "$name" != /* && "$name" != *..* ]] || fail "unsafe release input name: $name"
  [[ -f "$temp/$name" && ! -L "$temp/$name" ]] || fail "missing release input: $name"
  scp "${scp_args[@]}" "$temp/$name" \
    "$VPS_USER@$VPS_HOST:/var/lib/idnest/queue/incoming/$name.$id.upload"
done < <(read_release_inputs)
