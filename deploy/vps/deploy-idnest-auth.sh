#!/bin/sh
set -eu

fail() {
  echo "Idnest auth deployment failed: $*" >&2
  exit 1
}

[ "$#" -eq 3 ] || fail "usage: deploy-idnest-auth IMAGE@DIGEST GIT_REVISION GITHUB_RUN_ID"
PASSWORD_FILE=/var/lib/idnest/incoming/ecr-password.$3
IDNEST_CONFIG=/etc/idnest/idnest.conf
[ "$(id -u)" -eq 0 ] || fail "deployment must run as root through the release queue processor"
for file in "$PASSWORD_FILE" "$IDNEST_CONFIG"; do
  if ! {
    [ -f "$file" ] &&
      [ ! -L "$file" ] &&
      [ -s "$file" ]
  }; then
    fail "invalid required file: $file"
  fi
  [ "$(stat -c '%U' "$file")" = root ] || fail "required file must be root-owned: $file"
done
command -v curl >/dev/null 2>&1 || fail "curl is required"

# shellcheck source=/dev/null
. "$IDNEST_CONFIG"
HYDRA_ADMIN_HTTP_PORT=${HYDRA_ADMIN_HTTP_PORT:-4445}
KRATOS_PUBLIC_HTTP_PORT=${KRATOS_PUBLIC_HTTP_PORT:-8447}

curl --fail --silent --show-error --noproxy '*' \
  "http://127.0.0.1:$HYDRA_ADMIN_HTTP_PORT/health/ready" >/dev/null \
  || fail "Hydra is not ready; run the development identity workflow first"
curl --fail --silent --show-error --noproxy '*' \
  "http://127.0.0.1:$KRATOS_PUBLIC_HTTP_PORT/health/ready" >/dev/null \
  || fail "Kratos is not ready; run the development identity workflow first"

exec /usr/local/sbin/deploy-idnest-app auth "$@" <"$PASSWORD_FILE"
