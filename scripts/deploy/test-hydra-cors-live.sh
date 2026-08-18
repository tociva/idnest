#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Hydra live CORS test failed: $*" >&2
  exit 1
}

if [[ ${1:-} == '--' ]]; then
  shift
fi

if [[ $# -ne 1 ]]; then
  fail "usage: test-hydra-cors-live.sh HYDRA_PUBLIC_URL"
fi

hydra_public_url="${1%/}"
probe_origin="${HYDRA_CORS_PROBE_ORIGIN:-https://cors-probe.invalid}"
spa_origin="${HYDRA_SPA_CORS_ORIGIN:-}"

[[ "$hydra_public_url" == https://* || "$hydra_public_url" == http://127.0.0.1:* || "$hydra_public_url" == http://localhost:* ]] \
  || fail "HYDRA_PUBLIC_URL must use HTTPS or an HTTP loopback address"
[[ "$probe_origin" == http://* || "$probe_origin" == https://* ]] \
  || fail "HYDRA_CORS_PROBE_ORIGIN must be an HTTP(S) origin"
[[ -z "$spa_origin" || "$spa_origin" == http://* || "$spa_origin" == https://* ]] \
  || fail "HYDRA_SPA_CORS_ORIGIN must be empty or an HTTP(S) origin"

for command in awk curl mktemp rm sleep; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/idnest-hydra-cors-live.XXXXXX")"
headers_file="$temporary_directory/headers"
body_file="$temporary_directory/body"
cleanup() {
  rm -rf -- "$temporary_directory"
}
trap cleanup EXIT INT TERM

header_value() {
  local wanted_header="$1"
  awk -v wanted="$(printf '%s' "$wanted_header" | awk '{ print tolower($0) }')" '
    {
      line=$0
      sub(/\r$/, "", line)
      separator=index(line, ":")
      if (separator == 0) next
      name=substr(line, 1, separator - 1)
      if (tolower(name) != wanted) next
      value=substr(line, separator + 1)
      sub(/^[[:space:]]*/, "", value)
      found=value
    }
    END { print found }
  ' "$headers_file"
}

request_with_origin() {
  local method="$1" path="$2" origin="$3"
  shift 3
  local -a method_arguments=(--request "$method")
  if [[ "$method" == HEAD ]]; then
    method_arguments=(--head)
  fi
  : > "$headers_file"
  : > "$body_file"
  curl --silent --show-error --max-time 20 \
    "${method_arguments[@]}" \
    --header "Origin: $origin" \
    --dump-header "$headers_file" \
    --output "$body_file" \
    --write-out '%{http_code}' \
    "$@" \
    "$hydra_public_url$path"
}

request() {
  local method="$1" path="$2"
  shift 2
  request_with_origin "$method" "$path" "$probe_origin" "$@"
}

wait_for_gateway() {
  local path='/.well-known/openid-configuration'
  local attempt status='unreachable'

  for ((attempt = 1; attempt <= 30; attempt++)); do
    if status="$(request GET "$path")" && [[ "$status" =~ ^2 ]]; then
      return
    fi
    sleep 1
  done

  fail "GET $path did not become ready within 30 seconds (last HTTP status: $status)"
}

assert_public_metadata_cors() {
  local method="$1" path="$2" status allow_origin allow_credentials allow_methods
  status="$(request "$method" "$path" \
    --header 'Access-Control-Request-Method: GET')"
  [[ "$status" =~ ^2 ]] || fail "$method $path returned HTTP $status"

  allow_origin="$(header_value Access-Control-Allow-Origin)"
  allow_credentials="$(header_value Access-Control-Allow-Credentials)"
  allow_methods="$(header_value Access-Control-Allow-Methods)"
  [[ "$allow_origin" == '*' ]] \
    || fail "$method $path returned Access-Control-Allow-Origin=${allow_origin:-<missing>} instead of *"
  [[ -z "$allow_credentials" ]] \
    || fail "$method $path exposed Access-Control-Allow-Credentials=$allow_credentials"
  [[ "$allow_methods" == *GET* && "$allow_methods" == *HEAD* && "$allow_methods" == *OPTIONS* ]] \
    || fail "$method $path returned incomplete Access-Control-Allow-Methods=${allow_methods:-<missing>}"
}

assert_no_cors_origin() {
  local description="$1" status allow_origin
  shift
  status="$(request "$@")"
  allow_origin="$(header_value Access-Control-Allow-Origin)"
  [[ -z "$allow_origin" ]] \
    || fail "$description returned unexpected Access-Control-Allow-Origin=$allow_origin (HTTP $status)"
}

assert_spa_userinfo_preflight() {
  local status allow_origin allow_credentials allow_headers
  status="$(request_with_origin OPTIONS '/userinfo' "$spa_origin" \
    --header 'Access-Control-Request-Method: GET' \
    --header 'Access-Control-Request-Headers: authorization')"
  [[ "$status" =~ ^2 ]] || fail "OPTIONS /userinfo returned HTTP $status"

  allow_origin="$(header_value Access-Control-Allow-Origin)"
  allow_credentials="$(header_value Access-Control-Allow-Credentials)"
  allow_headers="$(header_value Access-Control-Allow-Headers)"
  [[ "$allow_origin" == "$spa_origin" ]] \
    || fail "OPTIONS /userinfo returned Access-Control-Allow-Origin=${allow_origin:-<missing>} instead of $spa_origin"
  [[ "$allow_credentials" == 'true' ]] \
    || fail "OPTIONS /userinfo returned Access-Control-Allow-Credentials=${allow_credentials:-<missing>} instead of true"
  [[ "${allow_headers,,}" == *authorization* ]] \
    || fail "OPTIONS /userinfo did not allow the Authorization header"
}

metadata_paths=(
  '/.well-known/openid-configuration'
  '/.well-known/oauth-authorization-server'
  '/.well-known/jwks.json'
)

wait_for_gateway

for metadata_path in "${metadata_paths[@]}"; do
  assert_public_metadata_cors GET "$metadata_path"
  assert_public_metadata_cors HEAD "$metadata_path"
  assert_public_metadata_cors OPTIONS "$metadata_path"
done

if [[ -n "$spa_origin" ]]; then
  assert_spa_userinfo_preflight
fi

assert_no_cors_origin \
  'POST to an OIDC metadata route' \
  POST '/.well-known/openid-configuration'
assert_no_cors_origin \
  'near-miss OIDC metadata route' \
  GET '/.well-known/jwks.json/extra'
assert_no_cors_origin \
  'unregistered token origin' \
  POST '/oauth2/token' \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data 'grant_type=authorization_code&client_id=cors-live-invalid-client&code=invalid&redirect_uri=https%3A%2F%2Fcors-probe.invalid%2Fcallback'
assert_no_cors_origin \
  'unregistered userinfo origin' \
  GET '/userinfo' \
  --header 'Authorization: Bearer cors-live-invalid-token'

if [[ -n "$spa_origin" ]]; then
  echo "Hydra live CORS boundary exposes metadata wildcard CORS and exact configured SPA access."
else
  echo "Hydra live CORS boundary is correctly limited to public OIDC metadata routes."
fi
