#!/bin/sh
set -eu

readonly QUEUE_ROOT=/var/lib/idnest/queue
readonly INCOMING_ROOT=$QUEUE_ROOT/incoming
readonly PROCESSING_ROOT=$QUEUE_ROOT/processing
readonly RESULTS_ROOT=$QUEUE_ROOT/results
readonly LOG_ROOT=/var/log/idnest
readonly DEPLOY_INCOMING=/var/lib/idnest/incoming
readonly HOST_ACTIVATOR=/usr/local/sbin/activate-idnest-host-release

fail() {
  echo "Release processing failed: $*" >&2
  exit 1
}

valid_kind() {
  case "$1" in auth|admin) return 0 ;; *) return 1 ;; esac
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
    auth) REQUIRED_INPUTS="host-release.tar.gz host-release.sig ecr-password idnest-config.tar.gz" ;;
    admin) REQUIRED_INPUTS="host-release.tar.gz host-release.sig ecr-password" ;;
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
  [ "$(wc -l <"$request_file" | tr -d ' ')" -eq 6 ] || fail "request must contain six fields"
  [ "$(grep -Ec '^(KIND|REQUEST_ID|GITHUB_RUN_ID|GIT_REVISION|IMAGE_REF|HOST_BUNDLE_SHA256)=' "$request_file")" -eq 6 ] || fail "request contains an unexpected field"
  request_kind=$(request_value KIND "$request_file")
  request_id=$(request_value REQUEST_ID "$request_file")
  RUN_ID=$(request_value GITHUB_RUN_ID "$request_file")
  REVISION=$(request_value GIT_REVISION "$request_file")
  IMAGE_REF=$(request_value IMAGE_REF "$request_file")
  HOST_BUNDLE_SHA256=$(request_value HOST_BUNDLE_SHA256 "$request_file")

  [ "$request_kind" = "$KIND" ] || fail "request kind does not match filename"
  [ "$request_id" = "$REQUEST_ID" ] || fail "request ID does not match filename"
  printf '%s\n' "$RUN_ID" | grep -Eq '^[1-9][0-9]*$' || fail "invalid GitHub run ID"
  printf '%s\n' "$REVISION" | grep -Eq '^[a-f0-9]{40}$' || fail "invalid Git revision"
  printf '%s\n' "$IMAGE_REF" | grep -Eq '^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$' || fail "invalid image reference"
  printf '%s\n' "$HOST_BUNDLE_SHA256" | grep -Eq '^[a-f0-9]{64}$' || fail "invalid host bundle checksum"

  write_result running
  "$HOST_ACTIVATOR" "$WORK_ROOT/host-release.tar.gz" "$WORK_ROOT/host-release.sig" \
    "$HOST_BUNDLE_SHA256" "$REVISION" "$REQUEST_ID"
  install -o root -g root -m 600 "$WORK_ROOT/ecr-password" "$DEPLOY_INCOMING/ecr-password.$RUN_ID"

  case "$KIND" in
    auth)
      install -o root -g root -m 600 "$WORK_ROOT/idnest-config.tar.gz" "$DEPLOY_INCOMING/idnest-config.tar.gz.$RUN_ID"
      /usr/local/sbin/deploy-idnest-auth "$IMAGE_REF" "$REVISION" "$RUN_ID"
      ;;
    admin)
      /usr/local/sbin/deploy-idnest-admin "$IMAGE_REF" "$REVISION" "$RUN_ID"
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
        "$DEPLOY_INCOMING/idnest-config.tar.gz.$RUN_ID"
    fi
    return "$exit_code"
  }
  trap finish_request EXIT
  trap 'exit 1' HUP INT TERM
  process_one "$request_path"
}

[ "$(id -u)" -eq 0 ] || fail "queue processor must run as root"
for command in chown chmod grep id install mv rm sed sha256sum stat tr wc; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
[ -x "$HOST_ACTIVATOR" ] || fail "host release activator is unavailable"

if [ "${1:-}" = --one ]; then
  [ "$#" -eq 2 ] || fail "invalid internal invocation"
  run_one "$2"
  exit 0
fi
[ "$#" -eq 0 ] || fail "this command does not accept arguments"

for request_path in "$INCOMING_ROOT"/request.auth.* "$INCOMING_ROOT"/request.admin.*; do
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
