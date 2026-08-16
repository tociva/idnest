#!/bin/sh
set -eu

readonly QUEUE_ROOT=/var/lib/ory-auth/queue
readonly INCOMING_ROOT=$QUEUE_ROOT/incoming
readonly RESULTS_ROOT=$QUEUE_ROOT/results

fail() {
  echo "Release submission failed: $*" >&2
  exit 1
}

valid_kind() {
  case "$1" in auth|admin) return 0 ;; *) return 1 ;; esac
}

valid_request_id() {
  printf '%s\n' "$1" | grep -Eq '^[1-9][0-9]*-[1-9][0-9]*$'
}

valid_positive_integer() {
  printf '%s\n' "$1" | grep -Eq '^[1-9][0-9]*$'
}

valid_revision() {
  printf '%s\n' "$1" | grep -Eq '^[a-f0-9]{40}$'
}

valid_image() {
  printf '%s\n' "$1" | grep -Eq '^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$'
}

valid_sha256() {
  printf '%s\n' "$1" | grep -Eq '^[a-f0-9]{64}$'
}

[ "$#" -eq 6 ] || fail "usage: submit-ory-release KIND REQUEST_ID GITHUB_RUN_ID GIT_REVISION IMAGE@DIGEST HOST_BUNDLE_SHA256"
KIND=$1
REQUEST_ID=$2
RUN_ID=$3
REVISION=$4
IMAGE_REF=$5
HOST_BUNDLE_SHA256=$6

valid_kind "$KIND" || fail "kind must be auth or admin"
valid_request_id "$REQUEST_ID" || fail "request ID must be GITHUB_RUN_ID-GITHUB_RUN_ATTEMPT"
valid_positive_integer "$RUN_ID" || fail "GitHub run ID must be a positive integer"
valid_revision "$REVISION" || fail "revision must be a full lowercase Git SHA"
valid_image "$IMAGE_REF" || fail "image must be an ECR URI pinned by sha256 digest"
valid_sha256 "$HOST_BUNDLE_SHA256" || fail "invalid host bundle checksum"

[ -d "$INCOMING_ROOT" ] && [ ! -L "$INCOMING_ROOT" ] || fail "release queue is not provisioned"
[ "$(stat -c '%u' "$INCOMING_ROOT")" -eq "$(id -u)" ] || fail "current user does not own the release queue"

case "$KIND" in
  auth) REQUIRED_UPLOADS="host-release.tar.gz host-release.sig ecr-password ory-config.tar.gz" ;;
  admin) REQUIRED_UPLOADS="host-release.tar.gz host-release.sig ecr-password" ;;
esac

for name in $REQUIRED_UPLOADS; do
  upload="$INCOMING_ROOT/$name.$REQUEST_ID.upload"
  [ -f "$upload" ] && [ ! -L "$upload" ] && [ -s "$upload" ] || fail "missing or invalid upload: $name"
  [ "$(stat -c '%u' "$upload")" -eq "$(id -u)" ] || fail "unexpected owner for upload: $name"
  [ ! -e "$INCOMING_ROOT/$name.$REQUEST_ID" ] || fail "release input already submitted: $name"
done
[ ! -e "$INCOMING_ROOT/request.$KIND.$REQUEST_ID" ] || fail "request already exists"
[ ! -e "$RESULTS_ROOT/$KIND.$REQUEST_ID.result" ] || fail "request ID already has a result"

umask 077
for name in $REQUIRED_UPLOADS; do
  mv -- "$INCOMING_ROOT/$name.$REQUEST_ID.upload" "$INCOMING_ROOT/$name.$REQUEST_ID"
done

request_candidate="$INCOMING_ROOT/.request.$KIND.$REQUEST_ID.$$"
{
  printf 'KIND=%s\n' "$KIND"
  printf 'REQUEST_ID=%s\n' "$REQUEST_ID"
  printf 'GITHUB_RUN_ID=%s\n' "$RUN_ID"
  printf 'GIT_REVISION=%s\n' "$REVISION"
  printf 'IMAGE_REF=%s\n' "$IMAGE_REF"
  printf 'HOST_BUNDLE_SHA256=%s\n' "$HOST_BUNDLE_SHA256"
} >"$request_candidate"
mv -- "$request_candidate" "$INCOMING_ROOT/request.$KIND.$REQUEST_ID"
echo "Submitted $KIND release request $REQUEST_ID."
