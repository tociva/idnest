#!/bin/sh
set -eu

fail() {
  echo "Builder image key generation failed: $*" >&2
  exit 1
}

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd "$SCRIPT_DIR/../.." && pwd)

sha256_stream() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  else
    fail "sha256sum or shasum is required"
  fi
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "sha256sum or shasum is required"
  fi
}

for command in awk find sort; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

inputs_file=$(mktemp "${TMPDIR:-/tmp}/idnest-builder-inputs.XXXXXX")
cleanup() {
  rm -f -- "$inputs_file"
}
trap cleanup EXIT HUP INT TERM

for relative_path in \
  scripts/docker/Dockerfile.builder-base \
  scripts/docker/builder-image-key.sh \
  monorepo/package.json \
  monorepo/pnpm-lock.yaml \
  monorepo/pnpm-workspace.yaml \
  monorepo/.npmrc \
  monorepo/nx.json \
  monorepo/tsconfig.base.json; do
  [ -f "$REPO_ROOT/$relative_path" ] && [ ! -L "$REPO_ROOT/$relative_path" ] \
    || fail "missing or invalid builder input: $relative_path"
  printf '%s\n' "$relative_path" >>"$inputs_file"
done

for workspace_directory in monorepo/apps monorepo/libs; do
  [ -d "$REPO_ROOT/$workspace_directory" ] && [ ! -L "$REPO_ROOT/$workspace_directory" ] \
    || fail "missing or invalid workspace directory: $workspace_directory"
done

find "$REPO_ROOT/monorepo/apps" "$REPO_ROOT/monorepo/libs" \
  -mindepth 2 -maxdepth 2 -type f -name package.json -print \
  | while IFS= read -r manifest; do
      printf '%s\n' "${manifest#"$REPO_ROOT/"}"
    done >>"$inputs_file"

LC_ALL=C sort -u "$inputs_file" -o "$inputs_file"

{
  printf '%s\n' 'idnest-builder-key-schema=v1' 'platform=linux/arm64'
  while IFS= read -r relative_path; do
    printf 'path=%s\nsha256=%s\n' \
      "$relative_path" \
      "$(sha256_file "$REPO_ROOT/$relative_path")"
  done <"$inputs_file"
} | sha256_stream
