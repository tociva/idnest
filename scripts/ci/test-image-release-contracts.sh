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
revision=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
mock_bin=$temporary/bin
mkdir -p "$mock_bin"

cat >"$mock_bin/aws" <<'EOF'
#!/usr/bin/env sh
set -eu
arguments=$*
case "$arguments" in
  *"describe-images"*"--query imageDetails[0].imageDigest"*)
    if [ -n "${MOCK_PUBLIC_STATE:-}" ]; then
      if [ -f "$MOCK_PUBLIC_STATE" ]; then
        printf '%s\n' "$MOCK_DIGEST"
      else
        printf '%s\n' None
      fi
    else
      printf '%s\n' "${MOCK_EXISTING_DIGEST:-None}"
    fi
    ;;
  *"describe-images"*"--query imageDetails[0]"*)
    printf '{"imageDigest":"%s","imageTags":["auth-v1.4.0","git-%s-123-1"]}\n' \
      "$MOCK_DIGEST" "$MOCK_REVISION"
    ;;
  *"batch-get-image"*"--query images[0].imageManifest"*)
    printf '%s\n' '{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json"}'
    ;;
  *"batch-get-image"*"--query images[0]"*)
    printf '%s\n' '{"imageManifest":"{\"schemaVersion\":2,\"mediaType\":\"application/vnd.oci.image.manifest.v1+json\"}","imageManifestMediaType":"application/vnd.oci.image.manifest.v1+json"}'
    ;;
  *"put-image"*)
    printf '%s\n' "$MOCK_DIGEST"
    ;;
  *"wait image-scan-complete"*)
    ;;
  *"describe-image-scan-findings"*)
    printf '%s\n' '0 0'
    ;;
  *"start-image-scan"*)
    ;;
  *)
    echo "Unexpected mocked AWS command: $arguments" >&2
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
export MOCK_REVISION=$revision
export PATH=$mock_bin:$PATH

scan_output=$($SCRIPT_DIR/gate-ecr-image-scan.sh idnest/auth-app "$digest")
[[ "$scan_output" == *"ECR scan passed"* ]] || fail "scan gate did not pass valid zero findings"

promotion_output=$($SCRIPT_DIR/promote-ecr-image.sh idnest/auth-app "$digest" auth-v1.4.0)
[[ "$promotion_output" == *"Published auth-v1.4.0"* ]] || fail "release promotion did not publish the version tag"

resolved=$($SCRIPT_DIR/resolve-ecr-release.sh \
  123456789012.dkr.ecr.ap-south-1.amazonaws.com idnest/auth-app auth 1.4.0)
grep -Fxq "digest=$digest" <<<"$resolved" || fail "release resolver returned the wrong digest"
grep -Fxq "revision=$revision" <<<"$resolved" || fail "release resolver returned the wrong revision"
grep -Fxq "tag=auth-v1.4.0" <<<"$resolved" || fail "release resolver returned the wrong tag"

MOCK_EXISTING_DIGEST=$digest
export MOCK_EXISTING_DIGEST
if $SCRIPT_DIR/promote-ecr-image.sh idnest/auth-app "$digest" auth-v1.4.0 >/dev/null 2>&1; then
  fail "release promotion accepted an existing immutable version"
fi

unset MOCK_EXISTING_DIGEST
export MOCK_PUBLIC_STATE=$temporary/public-promoted
public_promotion_output=$(ECR_PUBLIC_REGION=us-east-1 \
  "$SCRIPT_DIR/promote-ecr-public-image.sh" \
  public.ecr.aws/idnest idnest/auth-app "$digest" auth-v1.4.0)
[[ "$public_promotion_output" == *"Published public.ecr.aws/idnest/idnest/auth-app:auth-v1.4.0"* ]] \
  || fail "ECR Public promotion did not publish the version tag"
if ECR_PUBLIC_REGION=us-east-1 "$SCRIPT_DIR/promote-ecr-public-image.sh" \
  public.ecr.aws/idnest idnest/auth-app "$digest" auth-v1.4.0 >/dev/null 2>&1; then
  fail "ECR Public promotion accepted an existing immutable version"
fi

echo "Image release contracts passed."

