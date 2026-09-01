#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Release helper failed: $*" >&2
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
HOST_RELEASE_MANIFEST="$REPO_ROOT/scripts/deploy/manifests/host-release-files.txt"
IDENTITY_CONFIG_MANIFEST="$REPO_ROOT/scripts/deploy/manifests/identity-config-files.txt"

require_env() {
  local name=$1
  if [[ -z "${!name:-}" ]]; then
    fail "$name is required"
  fi
}

valid_component() {
  [[ "$1" == auth || "$1" == admin ]]
}

request_id() {
  require_env GITHUB_RUN_ID
  require_env GITHUB_RUN_ATTEMPT
  [[ "${GITHUB_RUN_ID}" =~ ^[1-9][0-9]*$ ]] || fail "GITHUB_RUN_ID must be a positive integer"
  [[ "${GITHUB_RUN_ATTEMPT}" =~ ^[1-9][0-9]*$ ]] || fail "GITHUB_RUN_ATTEMPT must be a positive integer"
  printf '%s-%s\n' "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT"
}

runner_temp() {
  require_env RUNNER_TEMP
  [[ -d "$RUNNER_TEMP" && ! -L "$RUNNER_TEMP" ]] || fail "RUNNER_TEMP must be a regular directory"
  printf '%s\n' "$RUNNER_TEMP"
}

sha256_file() {
  local file=$1
  sha256sum "$file" | awk '{print $1}'
}

create_archive_from_manifest() {
  local manifest=$1
  local archive=$2
  local line
  local files=()
  [[ -f "$manifest" && ! -L "$manifest" ]] || fail "invalid manifest: $manifest"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" != /* && "$line" != *..* ]] || fail "unsafe manifest entry in $manifest: $line"
    [[ -f "$REPO_ROOT/$line" && ! -L "$REPO_ROOT/$line" ]] || fail "invalid manifest file: $line"
    files+=("$line")
  done <"$manifest"
  [[ "${#files[@]}" -gt 0 ]] || fail "manifest is empty: $manifest"
  COPYFILE_DISABLE=1
  export COPYFILE_DISABLE
  (cd "$REPO_ROOT" && tar --create --gzip --file "$archive" "${files[@]}")
}

sign_file() {
  local input=$1
  local output=$2
  local signing_key
  signing_key="$(runner_temp)/host-release-signing-private.pem"
  [[ -f "$signing_key" && ! -L "$signing_key" ]] || fail "missing release signing private key"
  openssl pkeyutl -sign -rawin -inkey "$signing_key" -in "$input" -out "$output"
}

write_release_inputs() {
  local temp
  temp="$(runner_temp)"
  printf '%s\n' "$@" >"$temp/release-inputs.txt"
  chmod 600 "$temp/release-inputs.txt"
}

read_release_inputs() {
  local temp line
  temp="$(runner_temp)"
  [[ -f "$temp/release-inputs.txt" && ! -L "$temp/release-inputs.txt" ]] \
    || fail "release inputs file is missing; run prepare-release-request.sh first"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -n "$line" ]] || continue
    printf '%s\n' "$line"
  done <"$temp/release-inputs.txt"
}

prepare_ssh_and_signing_key() {
  local temp ssh_dir
  temp="$(runner_temp)"
  ssh_dir="$temp/idnest-ssh"
  require_env VPS_SSH_PRIVATE_KEY_B64
  require_env VPS_SSH_KNOWN_HOSTS_B64
  require_env HOST_RELEASE_SIGNING_PRIVATE_KEY_B64
  install -d -m 700 "$ssh_dir"
  printf '%s' "$VPS_SSH_PRIVATE_KEY_B64" | base64 --decode >"$ssh_dir/id_ed25519"
  printf '%s' "$VPS_SSH_KNOWN_HOSTS_B64" | base64 --decode >"$ssh_dir/known_hosts"
  printf '%s' "$HOST_RELEASE_SIGNING_PRIVATE_KEY_B64" | base64 --decode >"$temp/host-release-signing-private.pem"
  chmod 600 "$ssh_dir/id_ed25519" "$ssh_dir/known_hosts" "$temp/host-release-signing-private.pem"
  ssh-keygen -y -P '' -f "$ssh_dir/id_ed25519" >/dev/null
  ssh-keygen -l -f "$ssh_dir/known_hosts" >/dev/null
  openssl pkey -in "$temp/host-release-signing-private.pem" -noout
}
