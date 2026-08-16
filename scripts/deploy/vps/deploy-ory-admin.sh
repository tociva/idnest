#!/bin/sh
set -eu
if [ "$#" -ne 3 ]; then
  echo "usage: deploy-ory-admin IMAGE@DIGEST GIT_REVISION GITHUB_RUN_ID" >&2
  exit 1
fi
PASSWORD_FILE="/var/lib/ory-auth/incoming/ecr-password.$3"
[ "$(id -u)" -eq 0 ] || { echo "deployment must run as root through the release queue processor" >&2; exit 1; }
[ -f "$PASSWORD_FILE" ] && [ ! -L "$PASSWORD_FILE" ] && [ -s "$PASSWORD_FILE" ] || { echo "invalid staged ECR password" >&2; exit 1; }
[ "$(stat -c '%U' "$PASSWORD_FILE")" = root ] || { echo "staged ECR password must be root-owned" >&2; exit 1; }
exec /usr/local/sbin/deploy-ory-app admin "$@" <"$PASSWORD_FILE"
