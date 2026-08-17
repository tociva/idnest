#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ] || [[ -z "$1" || "$1" =~ [[:space:]] ]]; then
  echo "Usage: $0 IMAGE_REFERENCE" >&2
  exit 2
fi

image_ref="$1"
container_name="idnest-auth-smoke-${GITHUB_RUN_ID:-$$}"
tls_hostname=auth-smoke.invalid
tls_directory="$(mktemp -d "${TMPDIR:-/tmp}/idnest-auth-smoke-tls.XXXXXX")"
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
  --env AUTH_HTTPS_ENABLED=true \
  --env TLS_SERVER_NAME="$tls_hostname" \
  --env HYDRA_ADMIN_URL=http://hydra.invalid \
  --env KRATOS_ADMIN_URL=http://kratos.invalid \
  --env KRATOS_PUBLIC_URL=https://kratos.invalid \
  --env KRATOS_INTERNAL_URL=http://kratos.invalid \
  --env AUTHZ_DATABASE_URL= \
  --env CONSENT_GATE_MODE=observe \
  --env CONSENT_ACTION_SECRET=smoke-consent-secret-with-at-least-32-characters \
  --env AUTH_BRANDING_MODE=off \
  --env AUTH_TRANSACTION_SECRET=smoke-transaction-secret-with-at-least-32-characters \
  --env AUTH_AUDIT_HASH_SECRET=smoke-audit-secret-with-at-least-32-characters \
  --env AUTH_BASE_URL=https://auth.invalid \
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
  echo "Auth image unexpectedly accepted plaintext HTTP on its public port." >&2
  exit 1
fi
curl --fail --silent --cacert "$tls_certificate" \
  --resolve "$tls_hostname:${port}:127.0.0.1" \
  "https://${tls_hostname}:${port}/auth/" | grep -qi '<!doctype html>'
status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --cacert "$tls_certificate" --resolve "$tls_hostname:${port}:127.0.0.1" \
  "https://${tls_hostname}:${port}/auth/v1/not-a-route")"
[[ "$status" == 404 || "$status" == 405 ]]
echo "Auth image smoke test passed: $image_ref"
