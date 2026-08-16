#!/bin/sh
set -eu

fail() {
  echo "Application environment validation failed: $*" >&2
  exit 1
}

[ "$#" -eq 1 ] || fail "usage: validate-app-env.sh ENV_FILE"
env_file=$1
[ -f "$env_file" ] && [ ! -L "$env_file" ] || fail "environment file must be a regular file"
[ -s "$env_file" ] || fail "environment file is empty"

duplicates=$(
  awk '
    /^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/ {
      key=$0
      sub(/^[[:space:]]*/, "", key)
      sub(/[[:space:]]*=.*/, "", key)
      count[key]++
    }
    END { for (key in count) if (count[key] > 1) print key }
  ' "$env_file" | sort
)
[ -z "$duplicates" ] || fail "duplicate keys: $duplicates"

if grep -Eq '(^|=)(replace-with-|change-?me|todo)([^A-Za-z0-9]|$)' "$env_file"; then
  fail "environment file contains placeholder values"
fi

if grep -Ev '^[[:space:]]*(#.*)?$|^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=.*$' "$env_file" | grep -q .; then
  fail "environment file contains a non KEY=value line"
fi

echo "Application environment validation passed."
