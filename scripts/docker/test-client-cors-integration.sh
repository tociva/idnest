#!/usr/bin/env bash
set -euo pipefail

cors_test_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cors_test_container="idnest-client-cors-test-${GITHUB_RUN_ID:-local}-$$"
cors_test_image="oryd/hydra:v26.2.0"

cleanup_client_cors_test() {
  cors_test_exit_code=$?
  trap - EXIT INT TERM
  if [[ $cors_test_exit_code -ne 0 ]]; then
    docker logs "$cors_test_container" 2>/dev/null || true
  fi
  docker rm -f "$cors_test_container" >/dev/null 2>&1 || true
  exit "$cors_test_exit_code"
}
trap cleanup_client_cors_test EXIT INT TERM

docker run --rm -d \
  --name "$cors_test_container" \
  -p 127.0.0.1::4444 \
  -p 127.0.0.1::4445 \
  -e DSN=memory \
  -e LOG_LEVEL=error \
  -e SECRETS_SYSTEM=0123456789abcdef0123456789abcdef \
  -e URLS_SELF_ISSUER=http://hydra.cors.test/ \
  -e URLS_LOGIN=http://login.cors.test/login \
  -e URLS_CONSENT=http://login.cors.test/consent \
  -e SERVE_PUBLIC_CORS_ENABLED=true \
  -e SERVE_PUBLIC_CORS_ALLOWED_ORIGINS=https://hydra.cors.test,https://spa.cors.test \
  -e SERVE_PUBLIC_CORS_ALLOWED_METHODS=GET,POST,OPTIONS \
  -e SERVE_PUBLIC_CORS_ALLOWED_HEADERS=Authorization,Content-Type,Accept \
  -e SERVE_PUBLIC_CORS_ALLOW_CREDENTIALS=true \
  "$cors_test_image" serve all --dev >/dev/null

cors_test_public_binding="$(docker port "$cors_test_container" 4444/tcp)"
cors_test_admin_binding="$(docker port "$cors_test_container" 4445/tcp)"
cors_test_public_url="http://${cors_test_public_binding}"
cors_test_admin_url="http://${cors_test_admin_binding}"
cors_test_ready=false

for _attempt in $(seq 1 60); do
  if curl -fsS "$cors_test_admin_url/health/ready" >/dev/null 2>&1; then
    cors_test_ready=true
    break
  fi
  sleep 0.25
done

if [[ "$cors_test_ready" != true ]]; then
  echo "Hydra CORS integration container did not become ready." >&2
  exit 1
fi

HYDRA_CORS_INTEGRATION=1 \
HYDRA_CORS_TEST_ADMIN_URL="$cors_test_admin_url" \
HYDRA_CORS_TEST_PUBLIC_URL="$cors_test_public_url" \
pnpm --dir="$cors_test_repo_root/monorepo" exec vitest run \
  --root apps/admin-backend \
  --config vitest.config.ts \
  --reporter=verbose
