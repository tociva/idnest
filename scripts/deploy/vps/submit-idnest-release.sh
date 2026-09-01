#!/bin/sh
set -eu

readonly QUEUE_ROOT=/var/lib/idnest/queue
readonly INCOMING_ROOT=$QUEUE_ROOT/incoming
readonly RESULTS_ROOT=$QUEUE_ROOT/results

fail() {
  echo "Release submission failed: $*" >&2
  exit 1
}

valid_kind() {
  case "$1" in auth|admin|identity) return 0 ;; *) return 1 ;; esac
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

[ "$#" -eq 6 ] || [ "$#" -eq 7 ] \
  || fail "usage: submit-idnest-release auth|admin REQUEST_ID RUN_ID REVISION IMAGE@DIGEST HOST_SHA [APP_ENV_SHA]; or identity REQUEST_ID RUN_ID REVISION HOST_SHA IDENTITY_ENV_SHA IDENTITY_CONFIG_SHA"
KIND=$1
REQUEST_ID=$2
RUN_ID=$3
REVISION=$4

valid_kind "$KIND" || fail "kind must be auth, admin, or identity"
valid_request_id "$REQUEST_ID" || fail "request ID must be GITHUB_RUN_ID-GITHUB_RUN_ATTEMPT"
valid_positive_integer "$RUN_ID" || fail "GitHub run ID must be a positive integer"
[ "${REQUEST_ID%%-*}" = "$RUN_ID" ] || fail "request ID must start with the GitHub run ID"
valid_revision "$REVISION" || fail "revision must be a full lowercase Git SHA"
case "$KIND" in
  auth|admin)
    [ "$#" -eq 6 ] || [ "$#" -eq 7 ] \
      || fail "application release usage: submit-idnest-release $KIND REQUEST_ID RUN_ID REVISION IMAGE@DIGEST HOST_SHA [APP_ENV_SHA]"
    IMAGE_REF=$5
    HOST_BUNDLE_SHA256=$6
    valid_image "$IMAGE_REF" || fail "image must be an ECR URI pinned by sha256 digest"
    valid_sha256 "$HOST_BUNDLE_SHA256" || fail "invalid host bundle checksum"
    APP_ENV_SHA256=
    if [ "$#" -eq 7 ]; then
      APP_ENV_SHA256=$7
      valid_sha256 "$APP_ENV_SHA256" || fail "invalid application environment checksum"
    fi
    ;;
  identity)
    [ "$#" -eq 7 ] \
      || fail "identity release usage: submit-idnest-release identity REQUEST_ID RUN_ID REVISION HOST_SHA IDENTITY_ENV_SHA IDENTITY_CONFIG_SHA"
    HOST_BUNDLE_SHA256=$5
    IDENTITY_ENV_SHA256=$6
    IDENTITY_CONFIG_SHA256=$7
    valid_sha256 "$HOST_BUNDLE_SHA256" || fail "invalid host bundle checksum"
    valid_sha256 "$IDENTITY_ENV_SHA256" || fail "invalid identity environment checksum"
    valid_sha256 "$IDENTITY_CONFIG_SHA256" || fail "invalid identity configuration checksum"
    ;;
esac

[ -d "$INCOMING_ROOT" ] && [ ! -L "$INCOMING_ROOT" ] || fail "release queue is not provisioned"
[ "$(stat -c '%u' "$INCOMING_ROOT")" -eq "$(id -u)" ] || fail "current user does not own the release queue"

case "$KIND" in
  auth|admin)
    REQUIRED_UPLOADS="host-release.tar.gz host-release.sig ecr-password"
    if [ -n "$APP_ENV_SHA256" ]; then
      REQUIRED_UPLOADS="host-release.tar.gz host-release.sig app.env app-env.sig ecr-password"
    fi
    ;;
  identity) REQUIRED_UPLOADS="host-release.tar.gz host-release.sig idnest.env idnest-env.sig idnest-config.tar.gz idnest-config.sig" ;;
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
case "$KIND" in
  auth|admin)
    {
      printf 'KIND=%s\n' "$KIND"
      printf 'REQUEST_ID=%s\n' "$REQUEST_ID"
      printf 'GITHUB_RUN_ID=%s\n' "$RUN_ID"
      printf 'GIT_REVISION=%s\n' "$REVISION"
      printf 'IMAGE_REF=%s\n' "$IMAGE_REF"
      printf 'HOST_BUNDLE_SHA256=%s\n' "$HOST_BUNDLE_SHA256"
      if [ -n "$APP_ENV_SHA256" ]; then
        printf 'APP_ENV_SHA256=%s\n' "$APP_ENV_SHA256"
      fi
    } >"$request_candidate"
    ;;
  identity)
    {
      printf 'KIND=%s\n' "$KIND"
      printf 'REQUEST_ID=%s\n' "$REQUEST_ID"
      printf 'GITHUB_RUN_ID=%s\n' "$RUN_ID"
      printf 'GIT_REVISION=%s\n' "$REVISION"
      printf 'HOST_BUNDLE_SHA256=%s\n' "$HOST_BUNDLE_SHA256"
      printf 'IDENTITY_ENV_SHA256=%s\n' "$IDENTITY_ENV_SHA256"
      printf 'IDENTITY_CONFIG_SHA256=%s\n' "$IDENTITY_CONFIG_SHA256"
    } >"$request_candidate"
    ;;
esac
mv -- "$request_candidate" "$INCOMING_ROOT/request.$KIND.$REQUEST_ID"
echo "Submitted $KIND release request $REQUEST_ID."
