#!/bin/sh
set -eu

readonly QUEUE_ROOT=/var/lib/idnest/queue
readonly INCOMING_ROOT=$QUEUE_ROOT/incoming
readonly PROCESSING_ROOT=$QUEUE_ROOT/processing
readonly RESULTS_ROOT=$QUEUE_ROOT/results
readonly LOG_ROOT=/var/log/idnest
readonly DEPLOY_INCOMING=/var/lib/idnest/incoming
readonly HOST_ACTIVATOR=/usr/local/sbin/activate-idnest-host-release
readonly SIGNING_PUBLIC_KEY=/etc/idnest/host-release-signing-public.pem
readonly ENV_VALIDATOR=/usr/local/sbin/validate-idnest-app-env

fail() {
  echo "Release processing failed: $*" >&2
  exit 1
}

valid_kind() {
  case "$1" in auth|admin|identity) return 0 ;; *) return 1 ;; esac
}

valid_request_id() {
  printf '%s\n' "$1" | grep -Eq '^[1-9][0-9]*-[1-9][0-9]*$'
}

request_value() {
  key=$1
  file=$2
  [ "$(grep -c "^$key=" "$file")" -eq 1 ] || fail "request must contain exactly one $key"
  sed -n "s/^$key=//p" "$file"
}

write_result() {
  status=$1
  result_file="$RESULTS_ROOT/$KIND.$REQUEST_ID.result"
  candidate="$result_file.tmp.$$"
  umask 027
  {
    printf 'STATUS=%s\n' "$status"
    printf 'KIND=%s\n' "$KIND"
    printf 'REQUEST_ID=%s\n' "$REQUEST_ID"
    printf 'LOG_FILE=%s/%s.%s.log\n' "$LOG_ROOT" "$KIND" "$REQUEST_ID"
  } >"$candidate"
  chown root:"$QUEUE_GROUP" "$candidate"
  chmod 640 "$candidate"
  mv -- "$candidate" "$result_file"
}

process_one() {
  request_path=$1
  request_name=${request_path##*/}
  request_suffix=${request_name#request.}
  KIND=${request_suffix%%.*}
  REQUEST_ID=${request_suffix#*.}
  valid_kind "$KIND" || fail "invalid request kind in filename"
  valid_request_id "$REQUEST_ID" || fail "invalid request ID in filename"

  QUEUE_USER=$(stat -c '%U' "$INCOMING_ROOT")
  QUEUE_GROUP=$(stat -c '%G' "$RESULTS_ROOT")
  [ -f "$request_path" ] && [ ! -L "$request_path" ] || fail "invalid request file"
  [ "$(stat -c '%U' "$request_path")" = "$QUEUE_USER" ] || fail "request owner does not match queue owner"

  case "$KIND" in
    auth) REQUIRED_INPUTS="host-release.tar.gz host-release.sig app.env app-env.sig ecr-password" ;;
    admin) REQUIRED_INPUTS="host-release.tar.gz host-release.sig app.env app-env.sig ecr-password" ;;
    identity) REQUIRED_INPUTS="host-release.tar.gz host-release.sig idnest.env idnest-env.sig idnest-config.tar.gz idnest-config.sig" ;;
  esac

  WORK_ROOT="$PROCESSING_ROOT/$KIND.$REQUEST_ID"
  [ ! -e "$WORK_ROOT" ] || fail "processing directory already exists"
  install -d -o root -g root -m 700 "$WORK_ROOT"
  mv -- "$request_path" "$WORK_ROOT/request"
  chown root:root "$WORK_ROOT/request"
  chmod 600 "$WORK_ROOT/request"

  for name in $REQUIRED_INPUTS; do
    input="$INCOMING_ROOT/$name.$REQUEST_ID"
    [ -f "$input" ] && [ ! -L "$input" ] && [ -s "$input" ] || fail "invalid queued input: $name"
    [ "$(stat -c '%U' "$input")" = "$QUEUE_USER" ] || fail "unexpected queued input owner: $name"
    mv -- "$INCOMING_ROOT/$name.$REQUEST_ID" "$WORK_ROOT/$name"
    chown root:root "$WORK_ROOT/$name"
    chmod 600 "$WORK_ROOT/$name"
  done

  request_file="$WORK_ROOT/request"
  [ "$(wc -l <"$request_file" | tr -d ' ')" -eq 7 ] || fail "request must contain seven fields"
  case "$KIND" in
    auth|admin)
      [ "$(grep -Ec '^(KIND|REQUEST_ID|GITHUB_RUN_ID|GIT_REVISION|IMAGE_REF|HOST_BUNDLE_SHA256|APP_ENV_SHA256)=' "$request_file")" -eq 7 ] \
        || fail "application request contains an unexpected field"
      IMAGE_REF=$(request_value IMAGE_REF "$request_file")
      APP_ENV_SHA256=$(request_value APP_ENV_SHA256 "$request_file")
      printf '%s\n' "$IMAGE_REF" | grep -Eq '^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$' \
        || fail "invalid image reference"
      printf '%s\n' "$APP_ENV_SHA256" | grep -Eq '^[a-f0-9]{64}$' \
        || fail "invalid application environment checksum"
      actual_app_env_sha256=$(sha256sum "$WORK_ROOT/app.env" | awk '{print $1}')
      [ "$actual_app_env_sha256" = "$APP_ENV_SHA256" ] \
        || fail "application environment checksum mismatch"
      openssl pkeyutl -verify -rawin -pubin -inkey "$SIGNING_PUBLIC_KEY" \
        -sigfile "$WORK_ROOT/app-env.sig" -in "$WORK_ROOT/app.env" >/dev/null 2>&1 \
        || fail "application environment signature verification failed"
      ;;
    identity)
      [ "$(grep -Ec '^(KIND|REQUEST_ID|GITHUB_RUN_ID|GIT_REVISION|HOST_BUNDLE_SHA256|IDENTITY_ENV_SHA256|IDENTITY_CONFIG_SHA256)=' "$request_file")" -eq 7 ] \
        || fail "identity request contains an unexpected field"
      IDENTITY_ENV_SHA256=$(request_value IDENTITY_ENV_SHA256 "$request_file")
      IDENTITY_CONFIG_SHA256=$(request_value IDENTITY_CONFIG_SHA256 "$request_file")
      printf '%s\n' "$IDENTITY_ENV_SHA256" | grep -Eq '^[a-f0-9]{64}$' \
        || fail "invalid identity environment checksum"
      printf '%s\n' "$IDENTITY_CONFIG_SHA256" | grep -Eq '^[a-f0-9]{64}$' \
        || fail "invalid identity configuration checksum"
      actual_identity_env_sha256=$(sha256sum "$WORK_ROOT/idnest.env" | awk '{print $1}')
      [ "$actual_identity_env_sha256" = "$IDENTITY_ENV_SHA256" ] \
        || fail "identity environment checksum mismatch"
      actual_identity_config_sha256=$(sha256sum "$WORK_ROOT/idnest-config.tar.gz" | awk '{print $1}')
      [ "$actual_identity_config_sha256" = "$IDENTITY_CONFIG_SHA256" ] \
        || fail "identity configuration checksum mismatch"
      openssl pkeyutl -verify -rawin -pubin -inkey "$SIGNING_PUBLIC_KEY" \
        -sigfile "$WORK_ROOT/idnest-env.sig" -in "$WORK_ROOT/idnest.env" >/dev/null 2>&1 \
        || fail "identity environment signature verification failed"
      openssl pkeyutl -verify -rawin -pubin -inkey "$SIGNING_PUBLIC_KEY" \
        -sigfile "$WORK_ROOT/idnest-config.sig" -in "$WORK_ROOT/idnest-config.tar.gz" >/dev/null 2>&1 \
        || fail "identity configuration signature verification failed"
      ;;
  esac

  request_kind=$(request_value KIND "$request_file")
  request_id=$(request_value REQUEST_ID "$request_file")
  RUN_ID=$(request_value GITHUB_RUN_ID "$request_file")
  REVISION=$(request_value GIT_REVISION "$request_file")
  HOST_BUNDLE_SHA256=$(request_value HOST_BUNDLE_SHA256 "$request_file")

  [ "$request_kind" = "$KIND" ] || fail "request kind does not match filename"
  [ "$request_id" = "$REQUEST_ID" ] || fail "request ID does not match filename"
  printf '%s\n' "$RUN_ID" | grep -Eq '^[1-9][0-9]*$' || fail "invalid GitHub run ID"
  [ "${REQUEST_ID%%-*}" = "$RUN_ID" ] || fail "request ID does not match GitHub run ID"
  printf '%s\n' "$REVISION" | grep -Eq '^[a-f0-9]{40}$' || fail "invalid Git revision"
  printf '%s\n' "$HOST_BUNDLE_SHA256" | grep -Eq '^[a-f0-9]{64}$' || fail "invalid host bundle checksum"
  write_result running
  "$HOST_ACTIVATOR" "$WORK_ROOT/host-release.tar.gz" "$WORK_ROOT/host-release.sig" \
    "$HOST_BUNDLE_SHA256" "$REVISION" "$REQUEST_ID"
  case "$KIND" in
    auth)
      "$ENV_VALIDATOR" "$WORK_ROOT/app.env" auth >/dev/null
      install -o root -g root -m 600 "$WORK_ROOT/ecr-password" "$DEPLOY_INCOMING/ecr-password.$RUN_ID"
      install -o root -g root -m 600 "$WORK_ROOT/app.env" "$DEPLOY_INCOMING/auth-app.env.$RUN_ID"
      /usr/local/sbin/deploy-idnest-auth "$IMAGE_REF" "$REVISION" "$RUN_ID"
      ;;
    admin)
      "$ENV_VALIDATOR" "$WORK_ROOT/app.env" admin >/dev/null
      install -o root -g root -m 600 "$WORK_ROOT/ecr-password" "$DEPLOY_INCOMING/ecr-password.$RUN_ID"
      install -o root -g root -m 600 "$WORK_ROOT/app.env" "$DEPLOY_INCOMING/admin-app.env.$RUN_ID"
      /usr/local/sbin/deploy-idnest-admin "$IMAGE_REF" "$REVISION" "$RUN_ID"
      ;;
    identity)
      "$ENV_VALIDATOR" "$WORK_ROOT/idnest.env" identity >/dev/null
      install -o root -g root -m 600 "$WORK_ROOT/idnest.env" "$DEPLOY_INCOMING/idnest.env.$RUN_ID"
      install -o root -g root -m 600 "$WORK_ROOT/idnest-config.tar.gz" "$DEPLOY_INCOMING/idnest-config.tar.gz.$RUN_ID"
      /usr/local/sbin/deploy-idnest-infra "$RUN_ID" "$REQUEST_ID" "$REVISION"
      ;;
  esac

  SUCCEEDED=true
  write_result success
}

run_one() {
  request_path=$1
  request_name=${request_path##*/}
  request_suffix=${request_name#request.}
  KIND=${request_suffix%%.*}
  REQUEST_ID=${request_suffix#*.}
  QUEUE_GROUP=$(stat -c '%G' "$RESULTS_ROOT")
  WORK_ROOT=
  SUCCEEDED=false

  finish_request() {
    exit_code=$?
    if [ "$SUCCEEDED" != true ] && valid_kind "$KIND" && valid_request_id "$REQUEST_ID"; then
      write_result failure || true
    fi
    if [ -n "$WORK_ROOT" ] && [ -d "$WORK_ROOT" ] && [ ! -L "$WORK_ROOT" ]; then
      rm -rf -- "$WORK_ROOT"
    fi
    if printf '%s\n' "${RUN_ID:-}" | grep -Eq '^[1-9][0-9]*$'; then
      rm -f -- \
        "$DEPLOY_INCOMING/ecr-password.$RUN_ID" \
        "$DEPLOY_INCOMING/$KIND-app.env.$RUN_ID" \
        "$DEPLOY_INCOMING/idnest.env.$RUN_ID" \
        "$DEPLOY_INCOMING/idnest-config.tar.gz.$RUN_ID"
    fi
    return "$exit_code"
  }
  trap finish_request EXIT
  trap 'exit 1' HUP INT TERM
  process_one "$request_path"
}

[ "$(id -u)" -eq 0 ] || fail "queue processor must run as root"
for command in awk chown chmod grep id install mv openssl rm sed sha256sum stat tr wc; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
[ -x "$HOST_ACTIVATOR" ] || fail "host release activator is unavailable"
[ -x "$ENV_VALIDATOR" ] || fail "application environment validator is unavailable"
[ -f "$SIGNING_PUBLIC_KEY" ] && [ ! -L "$SIGNING_PUBLIC_KEY" ] \
  && [ "$(stat -c '%U' "$SIGNING_PUBLIC_KEY")" = root ] \
  || fail "release signing public key is unavailable"

if [ "${1:-}" = --one ]; then
  [ "$#" -eq 2 ] || fail "invalid internal invocation"
  run_one "$2"
  exit 0
fi
[ "$#" -eq 0 ] || fail "this command does not accept arguments"

for request_path in "$INCOMING_ROOT"/request.auth.* "$INCOMING_ROOT"/request.admin.* "$INCOMING_ROOT"/request.identity.*; do
  [ -e "$request_path" ] || continue
  request_name=${request_path##*/}
  request_suffix=${request_name#request.}
  kind=${request_suffix%%.*}
  request_id=${request_suffix#*.}
  if ! valid_kind "$kind" || ! valid_request_id "$request_id"; then
    rm -f -- "$request_path"
    continue
  fi
  log_file="$LOG_ROOT/$kind.$request_id.log"
  install -o root -g "$(stat -c '%G' "$RESULTS_ROOT")" -m 640 /dev/null "$log_file"
  "$0" --one "$request_path" >"$log_file" 2>&1 || true
done
