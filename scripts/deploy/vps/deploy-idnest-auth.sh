#!/bin/sh
set -eu

fail() {
  echo "Idnest auth deployment failed: $*" >&2
  exit 1
}

[ "$#" -eq 3 ] || fail "usage: deploy-idnest-auth IMAGE@DIGEST GIT_REVISION GITHUB_RUN_ID"
PASSWORD_FILE=/var/lib/idnest/incoming/ecr-password.$3
IDNEST_CONFIG=/etc/idnest/idnest.conf
TLS_CA_FILE=/etc/idnest/tls/origin-ca.pem
[ "$(id -u)" -eq 0 ] || fail "deployment must run as root through the release queue processor"
for file in "$PASSWORD_FILE" "$IDNEST_CONFIG" "$TLS_CA_FILE"; do
  [ -f "$file" ] && [ ! -L "$file" ] && [ -s "$file" ] \
    || fail "invalid required file: $file"
  [ "$(stat -c '%U' "$file")" = root ] || fail "required file must be root-owned: $file"
done
command -v curl >/dev/null 2>&1 || fail "curl is required"

# shellcheck source=/dev/null
. "$IDNEST_CONFIG"
: "${HYDRA_TLS_SERVER_NAME:?HYDRA_TLS_SERVER_NAME is required}"
: "${KRATOS_TLS_SERVER_NAME:?KRATOS_TLS_SERVER_NAME is required}"
HYDRA_ADMIN_HTTPS_PORT=${HYDRA_ADMIN_HTTPS_PORT:-4445}
KRATOS_ORIGIN_HTTPS_PORT=${KRATOS_ORIGIN_HTTPS_PORT:-8447}

curl --fail --silent --show-error --cacert "$TLS_CA_FILE" --noproxy '*' \
  --resolve "$HYDRA_TLS_SERVER_NAME:$HYDRA_ADMIN_HTTPS_PORT:127.0.0.1" \
  "https://$HYDRA_TLS_SERVER_NAME:$HYDRA_ADMIN_HTTPS_PORT/health/ready" >/dev/null \
  || fail "Hydra is not ready; run the development identity workflow first"
curl --fail --silent --show-error --cacert "$TLS_CA_FILE" --noproxy '*' \
  --resolve "$KRATOS_TLS_SERVER_NAME:$KRATOS_ORIGIN_HTTPS_PORT:127.0.0.1" \
  "https://$KRATOS_TLS_SERVER_NAME:$KRATOS_ORIGIN_HTTPS_PORT/health/ready" >/dev/null \
  || fail "Kratos is not ready; run the development identity workflow first"

exec /usr/local/sbin/deploy-idnest-app auth "$@" <"$PASSWORD_FILE"
