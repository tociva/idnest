#!/bin/sh
set -eu

template="${1:-/etc/config/kratos.tpl.yml}"
output="${2:-/tmp/kratos.yml}"
tmp="${output}.tmp"

# The rendered file contains secrets. Keep it private to the non-root Kratos
# process and write it outside the read-only configuration source directory.
umask 077

: "${KRATOS_CORS_ALLOWED_ORIGINS:?KRATOS_CORS_ALLOWED_ORIGINS is required}"
: "${KRATOS_TOTP_ISSUER:?KRATOS_TOTP_ISSUER is required}"

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

render_apple_private_key_yaml() {
  case "$APPLE_PRIVATE_KEY" in
    \"*\")
      # Deployment rendering already supplies a double-quoted YAML scalar with
      # literal \n escapes. Preserve that representation as-is.
      printf '%s\n' "$APPLE_PRIVATE_KEY"
      ;;
    \"*|*\")
      echo "APPLE_PRIVATE_KEY has an unmatched double quote." >&2
      return 1
      ;;
    *)
      # Docker Compose decodes a dotenv double-quoted value and passes the PEM
      # with real newlines. Encode it back into a safe YAML string.
      printf '%s\n' "$APPLE_PRIVATE_KEY" | awk '
        BEGIN { printf "\"" }
        {
          gsub(/\\/, "\\\\")
          gsub(/"/, "\\\"")
          gsub(/\r/, "")
          printf "%s\\n", $0
        }
        END { print "\"" }
      '
      ;;
  esac
}

KRATOS_CORS_ALLOWED_ORIGINS_YAML="$(render_cors_origins_yaml)"
export KRATOS_CORS_ALLOWED_ORIGINS_YAML

include_apple=false
APPLE_PRIVATE_KEY_YAML=
if has_apple_provider_config; then
  include_apple=true
  APPLE_PRIVATE_KEY_YAML="$(render_apple_private_key_yaml)"
elif has_any_apple_provider_config; then
  echo "Apple OIDC provider configuration is incomplete." >&2
  exit 1
fi
export APPLE_PRIVATE_KEY_YAML

awk -v include_apple="$include_apple" '
  /# BEGIN optional apple provider/ {
    if (include_apple != "true") skip_apple = 1
    next
  }
  /# END optional apple provider/ { skip_apple = 0; next }
  !skip_apple { print }
' "$template" | envsubst > "$tmp"

mv "$tmp" "$output"
