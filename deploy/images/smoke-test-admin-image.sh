#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ] || [[ -z "$1" || "$1" =~ [[:space:]] ]]; then
  echo "Usage: $0 IMAGE_REFERENCE" >&2
  exit 2
fi

image_ref="$1"
container_name="idnest-admin-smoke-${GITHUB_RUN_ID:-$$}"

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
  --env ADMIN_FRONTEND_API_BASE_URL=/api \
  --env ADMIN_FRONTEND_AUTH_LOGOUT_URL=https://auth.invalid/logout \
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

curl --fail --silent "http://127.0.0.1:${port}/" | grep -qi '<!doctype html>'
config="$(curl --fail --silent "http://127.0.0.1:${port}/config/config.json")"
node -e '
const config = JSON.parse(process.argv[1]);
if (config.apiBaseUrl !== "/api") process.exit(1);
if (config.authLogoutUrl !== "https://auth.invalid/logout") process.exit(1);
for (const key of Object.keys(config)) {
  if (/secret|password|dsn/i.test(key)) process.exit(1);
}
' "$config"
echo "Admin image smoke test passed over private-origin HTTP: $image_ref"
