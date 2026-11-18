#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH='' cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd "$SCRIPT_DIR/../.." && pwd)
KEY_VALIDATOR="$SCRIPT_DIR/validate-apple-private-key.sh"

fail() {
  echo "Apple development-key update failed: $*" >&2
  exit 1
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  fail "usage: update-development-apple-key.sh PRIVATE_KEY_FILE [DEVELOPMENT_ENV_FILE]"
fi

private_key_file=$1
development_env=${2:-$REPO_ROOT/tmp/development.env}

if [ ! -f "$private_key_file" ] || [ -L "$private_key_file" ] || [ ! -s "$private_key_file" ]; then
  fail "private key must be a non-empty regular file"
fi
if [ ! -f "$development_env" ] || [ -L "$development_env" ] || [ ! -s "$development_env" ]; then
  fail "development environment must be a non-empty regular file: $development_env"
fi

for command in awk chmod dirname mktemp mv rm; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

"$KEY_VALIDATOR" "$private_key_file" >/dev/null

development_directory=${development_env%/*}
[ "$development_directory" != "$development_env" ] || development_directory=.
if [ ! -d "$development_directory" ] || [ -L "$development_directory" ]; then
  fail "development environment directory must be a regular directory"
fi

umask 077
candidate=$(mktemp "$development_directory/.development.env.XXXXXX")
cleanup() {
  rm -f -- "$candidate"
}
trap cleanup EXIT HUP INT TERM

# Remove the canonical value and the retired Base64 field before appending the
# validated canonical value.
awk '
  !/^[[:space:]]*APPLE_PRIVATE_KEY(_B64)?[[:space:]]*=/ { print }
' "$development_env" >"$candidate"

apple_private_key=$(awk '
  BEGIN {
    backslash = sprintf("%c", 92)
    quote = sprintf("%c", 34)
    printf "%s", quote
  }
  {
    gsub(/\\/, backslash backslash)
    gsub(/"/, backslash quote)
    gsub(/\r/, "")
    printf "%s\\n", $0
  }
  END { printf "%s", quote }
' "$private_key_file")
printf "APPLE_PRIVATE_KEY='%s'\n" "$apple_private_key" >>"$candidate"

chmod 600 "$candidate"
mv -- "$candidate" "$development_env"
candidate=
trap - EXIT HUP INT TERM

echo "Updated APPLE_PRIVATE_KEY in $development_env."
