#!/usr/bin/env sh
set -eu

fail() {
  echo "ECR release resolution failed: $*" >&2
  exit 1
}

[ "$#" -eq 4 ] || fail "usage: $0 ECR_REGISTRY ECR_REPOSITORY COMPONENT VERSION"
registry=$1
repository=$2
component=$3
version=$4

printf '%s\n' "$registry" | grep -Eq '^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com$' \
  || fail "invalid ECR registry"
printf '%s\n' "$repository" | grep -Eq '^[a-z0-9][a-z0-9._/-]*$' || fail "invalid ECR repository"
case "$component" in auth|admin) ;; *) fail "component must be auth or admin" ;; esac
printf '%s\n' "$version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' \
  || fail "version must use X.Y.Z form"
release_tag=$component-v$version

details=$(aws ecr describe-images \
  --repository-name "$repository" \
  --image-ids "imageTag=$release_tag" \
  --query 'imageDetails[0]' \
  --output json) || fail "release tag does not exist: $release_tag"

resolved=$(printf '%s\n' "$details" | RELEASE_TAG="$release_tag" node -e '
const fs = require("node:fs");
const details = JSON.parse(fs.readFileSync(0, "utf8"));
const digest = details?.imageDigest || "";
const tags = details?.imageTags || [];
if (!/^sha256:[a-f0-9]{64}$/.test(digest)) process.exit(2);
if (!tags.includes(process.env.RELEASE_TAG)) process.exit(3);
const revisions = tags.flatMap((tag) => {
  const match = /^git-([a-f0-9]{40})-[0-9]+-[0-9]+$/.exec(tag);
  return match ? [match[1]] : [];
});
if (new Set(revisions).size !== 1) process.exit(4);
process.stdout.write(`${digest}\n${revisions[0]}\n`);
') || fail "release tag is missing an unambiguous Git revision tag"

digest=$(printf '%s\n' "$resolved" | sed -n '1p')
revision=$(printf '%s\n' "$resolved" | sed -n '2p')
printf '%s\n' "$digest" | grep -Eq '^sha256:[a-f0-9]{64}$' || fail "invalid resolved digest"
printf '%s\n' "$revision" | grep -Eq '^[a-f0-9]{40}$' || fail "invalid resolved revision"

printf 'tag=%s\n' "$release_tag"
printf 'digest=%s\n' "$digest"
printf 'revision=%s\n' "$revision"
printf 'image=%s/%s@%s\n' "$registry" "$repository" "$digest"

