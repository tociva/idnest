#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "ECR Public image promotion failed: $*" >&2
  exit 1
}

[ "$#" -eq 4 ] \
  || fail "usage: $0 ECR_PUBLIC_REGISTRY ECR_REPOSITORY IMAGE_DIGEST RELEASE_TAG"

registry=$1
repository=$2
digest=$3
release_tag=$4
region=${ECR_PUBLIC_REGION:-us-east-1}

[[ "$registry" =~ ^public\.ecr\.aws/[a-z0-9][a-z0-9._-]*$ ]] \
  || fail "invalid ECR Public registry"
[[ "$repository" =~ ^[a-z0-9][a-z0-9._/-]*$ ]] \
  || fail "invalid ECR repository"
[[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "invalid image digest"
[[ "$release_tag" =~ ^(auth|admin)-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
  || fail "invalid release tag"
[ "$region" = us-east-1 ] || fail "ECR Public region must be us-east-1"

for command in aws docker; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

existing_digest=$(aws ecr-public describe-images \
  --region "$region" \
  --repository-name "$repository" \
  --image-ids "imageTag=$release_tag" \
  --query 'imageDetails[0].imageDigest' \
  --output text 2>/dev/null || true)
[ -z "$existing_digest" ] || [ "$existing_digest" = None ] \
  || fail "release tag already exists: $release_tag"

image=$registry/$repository
docker buildx imagetools create --tag "$image:$release_tag" "$image@$digest" >/dev/null \
  || fail "could not publish release tag"

published_digest=$(aws ecr-public describe-images \
  --region "$region" \
  --repository-name "$repository" \
  --image-ids "imageTag=$release_tag" \
  --query 'imageDetails[0].imageDigest' \
  --output text)
[ "$published_digest" = "$digest" ] \
  || fail "published digest does not match the validated candidate"

printf 'Published %s/%s:%s at %s\n' "$registry" "$repository" "$release_tag" "$digest"
