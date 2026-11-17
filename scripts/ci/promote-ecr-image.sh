#!/usr/bin/env sh
set -eu

fail() {
  echo "ECR image promotion failed: $*" >&2
  exit 1
}

[ "$#" -eq 3 ] || fail "usage: $0 ECR_REPOSITORY IMAGE_DIGEST RELEASE_TAG"
repository=$1
digest=$2
release_tag=$3

printf '%s\n' "$repository" | grep -Eq '^[a-z0-9][a-z0-9._/-]*$' || fail "invalid ECR repository"
printf '%s\n' "$digest" | grep -Eq '^sha256:[a-f0-9]{64}$' || fail "invalid image digest"
printf '%s\n' "$release_tag" | grep -Eq '^(auth|admin)-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' \
  || fail "invalid release tag"

existing_digest=$(aws ecr describe-images \
  --repository-name "$repository" \
  --image-ids "imageTag=$release_tag" \
  --query 'imageDetails[0].imageDigest' \
  --output text 2>/dev/null || true)
[ "$existing_digest" = None ] && existing_digest=
[ -z "$existing_digest" ] || fail "release tag already exists: $release_tag"

manifest=$(aws ecr batch-get-image \
  --repository-name "$repository" \
  --image-ids "imageDigest=$digest" \
  --query 'images[0].imageManifest' \
  --output text) || fail "could not read candidate manifest"
[ -n "$manifest" ] && [ "$manifest" != None ] || fail "candidate manifest is missing"

promoted_digest=$(aws ecr put-image \
  --repository-name "$repository" \
  --image-tag "$release_tag" \
  --image-manifest "$manifest" \
  --query 'image.imageId.imageDigest' \
  --output text) || fail "could not create immutable release tag"
[ "$promoted_digest" = "$digest" ] \
  || fail "release tag resolved to $promoted_digest instead of $digest"

echo "Published $release_tag at $digest."

