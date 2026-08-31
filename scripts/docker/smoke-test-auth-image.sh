#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ] || [[ -z "$1" || "$1" =~ [[:space:]] ]]; then
  echo "Usage: $0 IMAGE_REFERENCE" >&2
  exit 2
fi

image_ref="$1"
container_name="idnest-auth-smoke-${GITHUB_RUN_ID:-$$}"

cleanup() {
  docker rm --force "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker run --detach --name "$container_name" --publish-all \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=32m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
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
  --env DELEGATION_ENABLED=false \
  --env AUTH_BASE_URL=https://auth.invalid \
  "$image_ref" >/dev/null

endpoint="$(docker port "$container_name" 3000/tcp)"
port="${endpoint##*:}"
[[ "$port" =~ ^[0-9]+$ ]]

deadline=$((SECONDS + 90))
until curl --fail --silent --show-error "http://127.0.0.1:${port}/health" >/dev/null; do
  if ((SECONDS >= deadline)); then
    docker logs "$container_name" >&2
    exit 1
  fi
  sleep 2
done

curl --fail --silent "http://127.0.0.1:${port}/auth/" | grep -qi '<!doctype html>'
status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  "http://127.0.0.1:${port}/auth/v1/not-a-route")"
[[ "$status" == 404 || "$status" == 405 ]]
delegation_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  "http://127.0.0.1:${port}/.well-known/idnest-delegation-configuration")"
[[ "$delegation_status" == 404 ]]
echo "Auth image smoke test passed over private-origin HTTP: $image_ref"
