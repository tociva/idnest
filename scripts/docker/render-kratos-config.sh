#!/bin/sh
set -eu

template="${1:-/etc/config/kratos.tpl.yml}"
output="${2:-/tmp/kratos.yml}"
tmp="${output}.tmp"

# The rendered file contains secrets. Keep it private to the non-root Kratos
# process and write it outside the read-only configuration source directory.
umask 077

: "${KRATOS_CORS_ALLOWED_ORIGINS:?KRATOS_CORS_ALLOWED_ORIGINS is required}"

render_cors_origins_yaml() {
  printf '%s\n' "${KRATOS_CORS_ALLOWED_ORIGINS:-}" | awk '
    {
      count = split($0, origins, ",")
      separator = ""
      printf "["
      for (i = 1; i <= count; i++) {
        origin = origins[i]
        sub(/^[[:space:]]+/, "", origin)
        sub(/[[:space:]]+$/, "", origin)
        if (origin == "") continue
        if (origin ~ /["\\]/) {
          print "KRATOS_CORS_ALLOWED_ORIGINS contains an unsupported quote or backslash." > "/dev/stderr"
          exit 1
        }
        printf "%s\"%s\"", separator, origin
        separator = ", "
      }
      print "]"
    }
  '
}

has_apple_provider_config() {
  [ -n "${APPLE_CLIENT_ID:-}" ] &&
    [ -n "${APPLE_TEAM_ID:-}" ] &&
    [ -n "${APPLE_PRIVATE_KEY_ID:-}" ] &&
    [ -n "${APPLE_PRIVATE_KEY:-}" ]
}

has_any_apple_provider_config() {
  [ -n "${APPLE_CLIENT_ID:-}" ] ||
    [ -n "${APPLE_TEAM_ID:-}" ] ||
    [ -n "${APPLE_PRIVATE_KEY_ID:-}" ] ||
    [ -n "${APPLE_PRIVATE_KEY:-}" ]
}

KRATOS_CORS_ALLOWED_ORIGINS_YAML="$(render_cors_origins_yaml)"
export KRATOS_CORS_ALLOWED_ORIGINS_YAML

include_apple=false
if has_apple_provider_config; then
  include_apple=true
elif has_any_apple_provider_config; then
  echo "Apple OIDC provider configuration is incomplete." >&2
  exit 1
fi

include_public_tls=false
if [ "${KRATOS_PUBLIC_TLS_ENABLED:-false}" = true ]; then
  include_public_tls=true
elif [ "${KRATOS_PUBLIC_TLS_ENABLED:-false}" != false ]; then
  echo "KRATOS_PUBLIC_TLS_ENABLED must be true or false." >&2
  exit 1
fi

awk -v include_apple="$include_apple" -v include_public_tls="$include_public_tls" '
  /# BEGIN optional apple provider/ {
    if (include_apple != "true") skip_apple = 1
    next
  }
  /# END optional apple provider/ { skip_apple = 0; next }
  /# BEGIN optional public tls/ {
    if (include_public_tls != "true") skip_public_tls = 1
    next
  }
  /# END optional public tls/ { skip_public_tls = 0; next }
  !skip_apple && !skip_public_tls { print }
' "$template" | envsubst > "$tmp"

mv "$tmp" "$output"
