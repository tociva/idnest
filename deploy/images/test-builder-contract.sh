#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Builder contract test failed: $*" >&2
  exit 1
}

SCRIPT_DIR=$(CDPATH='' cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd "$SCRIPT_DIR/../.." && pwd)

for command in cat chmod cp dirname find grep mkdir mktemp rm touch; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

sh -n "$SCRIPT_DIR/builder-image-key.sh"
bash -n "$SCRIPT_DIR/ensure-builder-image.sh"

actual_key=$("$SCRIPT_DIR/builder-image-key.sh")
[[ "$actual_key" =~ ^[a-f0-9]{64}$ ]] || fail "builder key is not a SHA-256 value"

grep -Eq '^ARG NODE_IMAGE=.*@sha256:[a-f0-9]{64}$' "$SCRIPT_DIR/Dockerfile.builder-base" \
  || fail "builder Node image is not pinned by digest"

expected_node_image='docker.io/library/node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee'
[ "$(cat "$REPO_ROOT/.nvmrc")" = 22.23.5 ] \
  || fail ".nvmrc does not match the approved Node runtime"
for dockerfile in \
  "$SCRIPT_DIR/Dockerfile.builder-base" \
  "$SCRIPT_DIR/Dockerfile.auth-app" \
  "$SCRIPT_DIR/Dockerfile.admin-app"; do
  grep -Fxq "ARG NODE_IMAGE=$expected_node_image" "$dockerfile" \
    || fail "$dockerfile does not use the approved Node runtime"
done

for application in auth admin; do
  dockerfile=$SCRIPT_DIR/Dockerfile.$application-app
  # BUILDER_IMAGE must remain literal for this Dockerfile contract assertion.
  # shellcheck disable=SC2016
  grep -Fq 'FROM ${BUILDER_IMAGE} AS build' "$dockerfile" \
    || fail "$dockerfile does not consume BUILDER_IMAGE"
  grep -Fq '/usr/local/lib/node_modules/npm' "$dockerfile" \
    || fail "$dockerfile does not remove npm from the runtime image"
  grep -Fq '/opt/yarn-v1.22.22' "$dockerfile" \
    || fail "$dockerfile does not remove Yarn from the runtime image"
  if grep -Eq 'pnpm .*install|corepack (enable|install)' "$dockerfile"; then
    fail "$dockerfile installs dependencies instead of consuming the builder"
  fi
done

for workflow in \
  "$REPO_ROOT/.github/workflows/build-application-image.yml" \
  "$REPO_ROOT/.github/workflows/build-builder-base.yml"; do
  grep -Fq 'runs-on: ubuntu-24.04-arm' "$workflow" \
    || fail "$workflow does not use a native ARM64 build runner"
  if grep -Eq 'setup-qemu|linux/amd64' "$workflow"; then
    fail "$workflow still contains an emulated or unused platform"
  fi
done
grep -Fq 'platforms: linux/arm64' "$REPO_ROOT/.github/workflows/build-application-image.yml" \
  || fail "application workflow does not publish only linux/arm64"
grep -Fq 'node-version: 22.23.5' "$REPO_ROOT/.github/workflows/build-application-image.yml" \
  || fail "application workflow does not test with the approved Node runtime"
grep -Fq 'TRIVY_PLATFORM: linux/arm64' "$REPO_ROOT/.github/workflows/build-application-image.yml" \
  || fail "application workflow does not scan the ARM64 image explicitly"
grep -Fq 'docker pull --platform linux/arm64' "$REPO_ROOT/.github/workflows/build-application-image.yml" \
  || fail "application workflow does not smoke-test the ARM64 image explicitly"
grep -Fq 'registry-type: public' "$REPO_ROOT/.github/workflows/build-application-image.yml" \
  || fail "application workflow does not authenticate to ECR Public"
grep -Fq 'registry-type: public' "$REPO_ROOT/.github/workflows/build-builder-base.yml" \
  || fail "builder workflow does not authenticate to ECR Public"

temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/idnest-builder-contract.XXXXXX")
cleanup() {
  rm -rf -- "$temporary_root"
}
trap cleanup EXIT HUP INT TERM

copy_root=$temporary_root/repository
for relative_path in \
  deploy/images/Dockerfile.builder-base \
  deploy/images/builder-image-key.sh \
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
chmod 755 "$copy_root/deploy/images/builder-image-key.sh"
baseline_key=$("$copy_root/deploy/images/builder-image-key.sh")

touch "$copy_root/monorepo/apps/auth-backend/src/source-only-change.ts"
source_key=$("$copy_root/deploy/images/builder-image-key.sh")
[ "$baseline_key" = "$source_key" ] \
  || fail "source-only changes invalidate the dependency builder key"

printf '\n' >>"$copy_root/monorepo/package.json"
dependency_key=$("$copy_root/deploy/images/builder-image-key.sh")
[ "$baseline_key" != "$dependency_key" ] \
  || fail "dependency manifest changes do not invalidate the builder key"

echo "ARM64 dependency builder contract passed: $actual_key"
