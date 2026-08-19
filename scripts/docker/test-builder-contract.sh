#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Builder contract test failed: $*" >&2
  exit 1
}

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd "$SCRIPT_DIR/../.." && pwd)

for command in chmod cp dirname find grep mkdir mktemp rm touch; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

sh -n "$SCRIPT_DIR/builder-image-key.sh"
bash -n "$SCRIPT_DIR/ensure-builder-image.sh"

actual_key=$($SCRIPT_DIR/builder-image-key.sh)
[[ "$actual_key" =~ ^[a-f0-9]{64}$ ]] || fail "builder key is not a SHA-256 value"

grep -Eq '^ARG NODE_IMAGE=.*@sha256:[a-f0-9]{64}$' "$SCRIPT_DIR/Dockerfile.builder-base" \
  || fail "builder Node image is not pinned by digest"

for application in auth admin; do
  dockerfile=$SCRIPT_DIR/Dockerfile.$application-app
  grep -Fq 'FROM ${BUILDER_IMAGE} AS build' "$dockerfile" \
    || fail "$dockerfile does not consume BUILDER_IMAGE"
  if grep -Eq 'pnpm .*install|corepack (enable|install)' "$dockerfile"; then
    fail "$dockerfile installs dependencies instead of consuming the builder"
  fi
done

for workflow in \
  "$REPO_ROOT/.github/workflows/deploy-auth-development.yml" \
  "$REPO_ROOT/.github/workflows/deploy-admin-development.yml"; do
  grep -Fq 'runs-on: ubuntu-24.04-arm' "$workflow" \
    || fail "$workflow does not use a native ARM64 build runner"
  grep -Fq 'platforms: linux/arm64' "$workflow" \
    || fail "$workflow does not publish only linux/arm64"
  if grep -Eq 'setup-qemu|linux/amd64' "$workflow"; then
    fail "$workflow still contains an emulated or unused platform"
  fi
done

temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/idnest-builder-contract.XXXXXX")
cleanup() {
  rm -rf -- "$temporary_root"
}
trap cleanup EXIT HUP INT TERM

copy_root=$temporary_root/repository
for relative_path in \
  scripts/docker/Dockerfile.builder-base \
  scripts/docker/builder-image-key.sh \
  monorepo/package.json \
  monorepo/pnpm-lock.yaml \
  monorepo/pnpm-workspace.yaml \
  monorepo/.npmrc \
  monorepo/nx.json \
  monorepo/tsconfig.base.json; do
  mkdir -p "$copy_root/$(dirname "$relative_path")"
  cp "$REPO_ROOT/$relative_path" "$copy_root/$relative_path"
done

while IFS= read -r manifest; do
  relative_path=${manifest#"$REPO_ROOT/"}
  mkdir -p "$copy_root/$(dirname "$relative_path")"
  cp "$manifest" "$copy_root/$relative_path"
done < <(
  find "$REPO_ROOT/monorepo/apps" "$REPO_ROOT/monorepo/libs" \
    -mindepth 2 -maxdepth 2 -type f -name package.json -print
)

mkdir -p "$copy_root/monorepo/apps/auth-backend/src"
chmod 755 "$copy_root/scripts/docker/builder-image-key.sh"
baseline_key=$($copy_root/scripts/docker/builder-image-key.sh)

touch "$copy_root/monorepo/apps/auth-backend/src/source-only-change.ts"
source_key=$($copy_root/scripts/docker/builder-image-key.sh)
[ "$baseline_key" = "$source_key" ] \
  || fail "source-only changes invalidate the dependency builder key"

printf '\n' >>"$copy_root/monorepo/package.json"
dependency_key=$($copy_root/scripts/docker/builder-image-key.sh)
[ "$baseline_key" != "$dependency_key" ] \
  || fail "dependency manifest changes do not invalidate the builder key"

echo "ARM64 dependency builder contract passed: $actual_key"
