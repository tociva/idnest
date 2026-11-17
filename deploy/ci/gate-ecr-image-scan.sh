#!/usr/bin/env sh
set -eu

fail() {
  echo "ECR image vulnerability gate failed: $*" >&2
  exit 1
}

[ "$#" -eq 2 ] || fail "usage: $0 ECR_REPOSITORY IMAGE_DIGEST"
repository=$1
requested_digest=$2
digest=$requested_digest
scan_platform=${ECR_SCAN_PLATFORM:-linux/arm64}
critical_limit=${ECR_CRITICAL_FINDING_LIMIT:-0}
high_limit=${ECR_HIGH_FINDING_LIMIT:-0}

printf '%s\n' "$repository" | grep -Eq '^[a-z0-9][a-z0-9._/-]*$' || fail "invalid ECR repository"
printf '%s\n' "$digest" | grep -Eq '^sha256:[a-f0-9]{64}$' || fail "invalid image digest"
printf '%s\n' "$scan_platform" | grep -Eq '^linux/(amd64|arm64)$' || fail "invalid scan platform"
printf '%s\n' "$critical_limit" | grep -Eq '^[0-9]+$' || fail "invalid critical limit"
printf '%s\n' "$high_limit" | grep -Eq '^[0-9]+$' || fail "invalid high limit"

image_metadata=$(aws ecr batch-get-image \
  --repository-name "$repository" \
  --image-ids "imageDigest=$digest" \
  --query 'images[0]' \
  --output json) || fail "could not read ECR image manifest metadata"

resolved_digest=$(printf '%s\n' "$image_metadata" | \
  IMAGE_DIGEST="$digest" ECR_SCAN_PLATFORM="$scan_platform" node -e '
const fs = require("node:fs");
const metadata = JSON.parse(fs.readFileSync(0, "utf8"));
const requested = process.env.IMAGE_DIGEST;
const [os, architecture] = process.env.ECR_SCAN_PLATFORM.split("/");
const indexTypes = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);
if (!metadata || typeof metadata.imageManifest !== "string") process.exit(2);
const manifest = JSON.parse(metadata.imageManifest);
const mediaType = metadata.imageManifestMediaType || manifest.mediaType;
if (!indexTypes.has(mediaType)) {
  process.stdout.write(requested);
  process.exit(0);
}
const entry = (manifest.manifests || []).find((candidate) =>
  candidate?.platform?.os === os && candidate?.platform?.architecture === architecture
);
if (!entry || !/^sha256:[a-f0-9]{64}$/.test(entry.digest || "")) process.exit(3);
process.stdout.write(entry.digest);
') || fail "could not resolve the $scan_platform image manifest"

printf '%s\n' "$resolved_digest" | grep -Eq '^sha256:[a-f0-9]{64}$' \
  || fail "ECR returned an invalid scan digest"
digest=$resolved_digest
image_id="imageDigest=$digest"

if ! aws ecr wait image-scan-complete \
  --repository-name "$repository" \
  --image-id "$image_id" >/dev/null 2>&1; then
  aws ecr start-image-scan \
    --repository-name "$repository" \
    --image-id "$image_id" >/dev/null 2>&1 \
    || fail "could not start the ECR image scan"
  aws ecr wait image-scan-complete \
    --repository-name "$repository" \
    --image-id "$image_id" >/dev/null \
    || fail "ECR image scan did not complete"
fi

counts=$(aws ecr describe-image-scan-findings \
  --repository-name "$repository" \
  --image-id "$image_id" \
  --query '[imageScanFindings.findingSeverityCounts.CRITICAL || `0`, imageScanFindings.findingSeverityCounts.HIGH || `0`]' \
  --output text) || fail "could not read ECR scan findings"
set -- $counts
[ "$#" -eq 2 ] || fail "ECR returned unexpected severity counts"
critical=$1
high=$2
printf '%s\n' "$critical" | grep -Eq '^[0-9]+$' || fail "invalid critical count"
printf '%s\n' "$high" | grep -Eq '^[0-9]+$' || fail "invalid high count"

if [ "$critical" -gt "$critical_limit" ] || [ "$high" -gt "$high_limit" ]; then
  fail "$requested_digest has CRITICAL=$critical and HIGH=$high findings (limits: $critical_limit/$high_limit)"
fi

echo "ECR scan passed for $requested_digest ($scan_platform CRITICAL=$critical HIGH=$high)."

