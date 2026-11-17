#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Image release contract failed: $*" >&2
  exit 1
}

SCRIPT_DIR=$(CDPATH= cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
temporary=$(mktemp -d "${TMPDIR:-/tmp}/idnest-image-release-contract.XXXXXX")
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT HUP INT TERM

digest=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
mock_bin=$temporary/bin
mkdir -p "$mock_bin"

cat >"$mock_bin/aws" <<'EOF'
#!/usr/bin/env sh
set -eu
case "$*" in
  *"describe-images"*)
    if [ -f "$MOCK_PUBLIC_STATE" ]; then
      printf '%s\n' "$MOCK_DIGEST"
    else
      printf '%s\n' None
    fi
    ;;
  *)
    echo "Unexpected mocked AWS command: $*" >&2
    exit 64
    ;;
esac
EOF
chmod 700 "$mock_bin/aws"

cat >"$mock_bin/docker" <<'EOF'
#!/usr/bin/env sh
set -eu
case "$*" in
  "buildx imagetools create --tag public.ecr.aws/idnest/idnest/auth-app:auth-v1.4.0 public.ecr.aws/idnest/idnest/auth-app@"*)
    : >"$MOCK_PUBLIC_STATE"
    ;;
  *)
    echo "Unexpected mocked Docker command: $*" >&2
    exit 64
    ;;
esac
EOF
chmod 700 "$mock_bin/docker"

export MOCK_DIGEST=$digest
export MOCK_PUBLIC_STATE=$temporary/public-promoted
export PATH=$mock_bin:$PATH

output=$(ECR_PUBLIC_REGION=us-east-1 \
  "$SCRIPT_DIR/promote-ecr-public-image.sh" \
  public.ecr.aws/idnest idnest/auth-app "$digest" auth-v1.4.0)
[[ "$output" == *"Published public.ecr.aws/idnest/idnest/auth-app:auth-v1.4.0"* ]] \
  || fail "ECR Public promotion did not publish the version tag"

if ECR_PUBLIC_REGION=us-east-1 "$SCRIPT_DIR/promote-ecr-public-image.sh" \
  public.ecr.aws/idnest idnest/auth-app "$digest" auth-v1.4.0 >/dev/null 2>&1; then
  fail "ECR Public promotion accepted an existing immutable version"
fi

echo "ECR Public image release contracts passed."
