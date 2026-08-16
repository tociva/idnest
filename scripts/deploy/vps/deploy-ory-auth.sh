#!/bin/sh
set -eu
if [ "$#" -ne 3 ]; then
  echo "usage: deploy-ory-auth IMAGE@DIGEST GIT_REVISION GITHUB_RUN_ID" >&2
  exit 1
fi
PASSWORD_FILE="/var/lib/ory-auth/incoming/ecr-password.$3"
[ "$(id -u)" -eq 0 ] || { echo "deployment must run as root through the release queue processor" >&2; exit 1; }
[ -f "$PASSWORD_FILE" ] && [ ! -L "$PASSWORD_FILE" ] && [ -s "$PASSWORD_FILE" ] || { echo "invalid staged ECR password" >&2; exit 1; }
[ "$(stat -c '%U' "$PASSWORD_FILE")" = root ] || { echo "staged ECR password must be root-owned" >&2; exit 1; }
if [ -f "/var/lib/ory-auth/incoming/ory-config.tar.gz.$3" ]; then
  /usr/local/sbin/deploy-ory-infra "$3"
fi
exec /usr/local/sbin/deploy-ory-app auth "$@" <"$PASSWORD_FILE"
