#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ] || [[ -z "$1" || "$1" =~ [[:space:]] ]]; then
  echo "Usage: $0 IMAGE_REFERENCE" >&2
  exit 2
fi

image_ref="$1"
container_name="idnest-admin-smoke-${GITHUB_RUN_ID:-$$}"
tls_hostname=admin-smoke.invalid
tls_directory="$(mktemp -d "${TMPDIR:-/tmp}/idnest-admin-smoke-tls.XXXXXX")"
tls_certificate="$tls_directory/origin-cert.pem"
tls_key="$tls_directory/origin-key.pem"

cleanup() {
  docker rm --force "$container_name" >/dev/null 2>&1 || true
  rm -rf -- "$tls_directory"
}
trap cleanup EXIT
cleanup

mkdir -p "$tls_directory"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout "$tls_key" -out "$tls_certificate" \
  -subj "/CN=$tls_hostname" -addext "subjectAltName=DNS:$tls_hostname" >/dev/null 2>&1
chmod 644 "$tls_certificate" "$tls_key"

docker run --detach --name "$container_name" --publish-all \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=32m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --volume "$tls_certificate:/run/idnest-tls/origin-cert.pem:ro" \
  --volume "$tls_key:/run/idnest-tls/origin-key.pem:ro" \
  --env ADMIN_HTTPS_ENABLED=true \
  --env TLS_SERVER_NAME="$tls_hostname" \
  --env ADMIN_FRONTEND_API_BASE_URL=/api \
  --env ADMIN_FRONTEND_AUTH_LOGOUT_URL=https://auth.invalid/logout \
  "$image_ref" >/dev/null

endpoint="$(docker port "$container_name" 3000/tcp)"
port="${endpoint##*:}"
[[ "$port" =~ ^[0-9]+$ ]]

deadline=$((SECONDS + 90))
until curl --fail --silent --show-error --cacert "$tls_certificate" \
  --resolve "$tls_hostname:${port}:127.0.0.1" \
  "https://${tls_hostname}:${port}/health" >/dev/null; do
  if ((SECONDS >= deadline)); then
    docker logs "$container_name" >&2
    exit 1
  fi
  sleep 2
done

if curl --fail --silent "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
  echo "Admin image unexpectedly accepted plaintext HTTP on its public port." >&2
  exit 1
fi
curl --fail --silent --cacert "$tls_certificate" \
  --resolve "$tls_hostname:${port}:127.0.0.1" \
  "https://${tls_hostname}:${port}/" | grep -qi '<!doctype html>'
config="$(curl --fail --silent --cacert "$tls_certificate" \
  --resolve "$tls_hostname:${port}:127.0.0.1" \
  "https://${tls_hostname}:${port}/config/config.json")"
node -e '
const config = JSON.parse(process.argv[1]);
if (config.apiBaseUrl !== "/api") process.exit(1);
if (config.authLogoutUrl !== "https://auth.invalid/logout") process.exit(1);
for (const key of Object.keys(config)) {
  if (/secret|password|dsn/i.test(key)) process.exit(1);
}
' "$config"
echo "Admin image smoke test passed: $image_ref"
