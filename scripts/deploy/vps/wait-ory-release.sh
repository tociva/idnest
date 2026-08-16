#!/bin/sh
set -eu

readonly RESULTS_ROOT=/var/lib/ory-auth/queue/results
readonly LOG_ROOT=/var/log/ory-auth

fail() {
  echo "Release wait failed: $*" >&2
  exit 1
}

[ "$#" -ge 2 ] && [ "$#" -le 3 ] || fail "usage: wait-ory-release KIND REQUEST_ID [TIMEOUT_SECONDS]"
KIND=$1
REQUEST_ID=$2
TIMEOUT_SECONDS=${3:-1800}
case "$KIND" in auth|admin) ;; *) fail "kind must be auth or admin" ;; esac
printf '%s\n' "$REQUEST_ID" | grep -Eq '^[1-9][0-9]*-[1-9][0-9]*$' || fail "invalid request ID"
printf '%s\n' "$TIMEOUT_SECONDS" | grep -Eq '^[1-9][0-9]*$' || fail "timeout must be a positive integer"

RESULT_FILE="$RESULTS_ROOT/$KIND.$REQUEST_ID.result"
LOG_FILE="$LOG_ROOT/$KIND.$REQUEST_ID.log"
started_at=$(date +%s)

while :; do
  if [ -f "$RESULT_FILE" ] && [ ! -L "$RESULT_FILE" ]; then
    [ "$(stat -c '%U' "$RESULT_FILE")" = root ] || fail "result has an unexpected owner"
    status=$(sed -n 's/^STATUS=//p' "$RESULT_FILE")
    case "$status" in
      success)
        [ ! -f "$LOG_FILE" ] || cat "$LOG_FILE"
        echo "Release request $REQUEST_ID completed successfully."
        exit 0
        ;;
      failure)
        [ ! -f "$LOG_FILE" ] || cat "$LOG_FILE" >&2
        fail "release request $REQUEST_ID failed; VPS log: $LOG_FILE"
        ;;
      running) ;;
      *) fail "release request returned an invalid status" ;;
    esac
  fi

  now=$(date +%s)
  [ $((now - started_at)) -lt "$TIMEOUT_SECONDS" ] || fail "timed out; inspect $RESULT_FILE and $LOG_FILE on the VPS"
  sleep 2
done
