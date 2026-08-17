#!/bin/sh
set -eu
if [ "$#" -ne 3 ]; then
  echo "usage: deploy-idnest-auth IMAGE@DIGEST GIT_REVISION GITHUB_RUN_ID" >&2
  exit 1
fi
PASSWORD_FILE="/var/lib/idnest/incoming/ecr-password.$3"
[ "$(id -u)" -eq 0 ] || { echo "deployment must run as root through the release queue processor" >&2; exit 1; }
[ -f "$PASSWORD_FILE" ] && [ ! -L "$PASSWORD_FILE" ] && [ -s "$PASSWORD_FILE" ] || { echo "invalid staged ECR password" >&2; exit 1; }
[ "$(stat -c '%U' "$PASSWORD_FILE")" = root ] || { echo "staged ECR password must be root-owned" >&2; exit 1; }
if [ -f "/var/lib/idnest/incoming/idnest-config.tar.gz.$3" ]; then
  /usr/local/sbin/deploy-idnest-infra "$3"
fi
exec /usr/local/sbin/deploy-idnest-app auth "$@" <"$PASSWORD_FILE"
