#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Builder image ensure failed: $*" >&2
  exit 1
}

if [ "$#" -ne 4 ]; then
  echo "Usage: $0 AWS_ACCOUNT_ID AWS_REGION ECR_REPOSITORY OUTPUT_FILE" >&2
  exit 2
fi

aws_account_id=$1
aws_region=$2
ecr_repository=$3
output_file=$4

[[ "$aws_account_id" =~ ^[0-9]{12}$ ]] || fail "AWS account ID must contain exactly 12 digits"
[[ "$aws_region" =~ ^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$ ]] || fail "invalid AWS region"
[[ "$ecr_repository" =~ ^[a-z0-9][a-z0-9._/-]*$ ]] || fail "invalid ECR repository name"
[ -n "$output_file" ] && [ ! -L "$output_file" ] || fail "output file must not be a symbolic link"
[ ! -e "$output_file" ] || [ -f "$output_file" ] || fail "output path must be a regular file"

for command in aws chmod dirname docker mktemp mv rm; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd "$SCRIPT_DIR/../.." && pwd)
KEY_SCRIPT=$SCRIPT_DIR/builder-image-key.sh
[ -x "$KEY_SCRIPT" ] && [ ! -L "$KEY_SCRIPT" ] || fail "missing executable key helper: $KEY_SCRIPT"

builder_key=$($KEY_SCRIPT)
[[ "$builder_key" =~ ^[a-f0-9]{64}$ ]] || fail "key helper returned an invalid SHA-256 value"

image_tag=deps-$builder_key
registry=$aws_account_id.dkr.ecr.$aws_region.amazonaws.com
tagged_image=$registry/$ecr_repository:$image_tag

resolve_digest() {
  aws ecr describe-images \
    --region "$aws_region" \
    --repository-name "$ecr_repository" \
    --image-ids "imageTag=$image_tag" \
    --query 'imageDetails[0].imageDigest' \
    --output text 2>/dev/null || true
}

builder_digest=$(resolve_digest)
cache_hit=true

if [[ ! "$builder_digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  cache_hit=false
  docker buildx inspect >/dev/null 2>&1 || fail "Docker Buildx is not configured"

  source_url=${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-tociva/idnest}

  build_status=0
  docker buildx build \
    --file "$SCRIPT_DIR/Dockerfile.builder-base" \
    --platform linux/arm64 \
    --build-arg "BUILDER_KEY=$builder_key" \
    --build-arg "BUILDER_SOURCE=$source_url" \
    --tag "$tagged_image" \
    --provenance=mode=max \
    --sbom=true \
    --push \
    "$REPO_ROOT" || build_status=$?

  builder_digest=$(resolve_digest)
  if [ "$build_status" -ne 0 ] && [[ ! "$builder_digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    fail "builder image build failed and no concurrent immutable image was published"
  fi
fi

[[ "$builder_digest" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "ECR returned an invalid builder image digest"
builder_image=$registry/$ecr_repository@$builder_digest

output_directory=$(dirname "$output_file")
[ -d "$output_directory" ] && [ ! -L "$output_directory" ] \
  || fail "output directory must be a regular directory"
temporary_output=$(mktemp "$output_directory/.builder-image.XXXXXX")
cleanup() {
  rm -f -- "${temporary_output:-}"
}
trap cleanup EXIT HUP INT TERM
{
  printf 'BUILDER_IMAGE=%s\n' "$builder_image"
  printf 'BUILDER_KEY=%s\n' "$builder_key"
  printf 'BUILDER_CACHE_HIT=%s\n' "$cache_hit"
} >"$temporary_output"
chmod 600 "$temporary_output"
mv "$temporary_output" "$output_file"
temporary_output=
trap - EXIT HUP INT TERM

printf 'Builder image ready: %s (%s)\n' "$builder_image" \
  "$([ "$cache_hit" = true ] && printf cached || printf published)"
