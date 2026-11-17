#!/usr/bin/env bash
# Resolve a previously published development auth/admin ECR image without
# rebuilding. Host deploy still runs the selected image's migrations and does
# not reverse a newer schema.
set -euo pipefail

fail() {
  echo "Development rollback image resolve failed: $*" >&2
  exit 1
}

if [ "$#" -ne 5 ]; then
  echo "Usage: $0 AWS_ACCOUNT_ID AWS_REGION ECR_REPOSITORY VERSION OUTPUT_FILE" >&2
  exit 2
fi

aws_account_id=$1
aws_region=$2
ecr_repository=$3
version=$(printf '%s' "$4" | tr -d '[:space:]')
output_file=$5

[[ "$aws_account_id" =~ ^[0-9]{12}$ ]] || fail "AWS account ID must contain exactly 12 digits"
[[ "$aws_region" =~ ^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$ ]] || fail "invalid AWS region"
[[ "$ecr_repository" =~ ^[a-z0-9][a-z0-9._/-]*$ ]] || fail "invalid ECR repository name"
[ -n "$version" ] || fail "version is required"
[ -n "$output_file" ] && [ ! -L "$output_file" ] || fail "output file must not be a symbolic link"
[ ! -e "$output_file" ] || [ -f "$output_file" ] || fail "output path must be a regular file"

for command in aws chmod dirname mktemp mv rm tr; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

image_id=
requested_tag=
if [[ "$version" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  image_id="imageDigest=$version"
elif [[ "$version" =~ ^git-[a-f0-9]{40}-[1-9][0-9]*-[1-9][0-9]*$ ]]; then
  image_id="imageTag=$version"
  requested_tag=$version
else
  fail "version must be sha256:<digest> or git-<40-char-sha>-<run_id>-<attempt>"
fi

describe_images() {
  aws ecr describe-images \
    --region "$aws_region" \
    --repository-name "$ecr_repository" \
    --image-ids "$image_id" \
    --output text \
    --query "$1" \
    2>/dev/null || true
}

image_digest=$(describe_images 'imageDetails[0].imageDigest')
tags=$(describe_images 'imageDetails[0].imageTags[]')
[ "$tags" = None ] && tags=

[[ "$image_digest" =~ ^sha256:[a-f0-9]{64}$ ]] \
  || fail "image version was not found in ${ecr_repository}: ${version}"

if [ -n "$requested_tag" ]; then
  found_requested=false
  for tag in $tags; do
    if [ "$tag" = "$requested_tag" ]; then
      found_requested=true
      break
    fi
  done
  [ "$found_requested" = true ] \
    || fail "ECR did not return the requested tag ${requested_tag}"
fi

revision=
matched_tag=
for tag in $tags; do
  if [[ "$tag" =~ ^git-([a-f0-9]{40})-[1-9][0-9]*-[1-9][0-9]*$ ]]; then
    candidate=${BASH_REMATCH[1]}
    if [ -n "$revision" ] && [ "$revision" != "$candidate" ]; then
      fail "image has git tags for more than one revision"
    fi
    revision=$candidate
    matched_tag=$tag
  fi
done
[ -n "$revision" ] && [[ "$revision" =~ ^[a-f0-9]{40}$ ]] \
  || fail "image has no git-<sha>-<run>-<attempt> tag to recover the Git revision"

output_directory=$(dirname "$output_file")
[ -d "$output_directory" ] && [ ! -L "$output_directory" ] \
  || fail "output directory must be a regular directory"

temporary_output=$(mktemp "$output_directory/.rollback-image.XXXXXX")
cleanup() {
  rm -f -- "${temporary_output:-}"
}
trap cleanup EXIT HUP INT TERM
{
  printf 'IMAGE_DIGEST=%s\n' "$image_digest"
  printf 'REVISION=%s\n' "$revision"
} >"$temporary_output"
chmod 600 "$temporary_output"
mv "$temporary_output" "$output_file"
temporary_output=
trap - EXIT HUP INT TERM

printf 'Resolved rollback image: %s/%s@%s (tag %s, revision %s)\n' \
  "$aws_account_id.dkr.ecr.$aws_region.amazonaws.com" \
  "$ecr_repository" \
  "$image_digest" \
  "$matched_tag" \
  "$revision"
