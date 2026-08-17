#!/bin/sh
set -eu

fail() {
  echo "Development credential generation failed: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/deploy/create-development-credentials.sh [VPS_HOST] [VPS_PORT]

Creates development deployment credentials in ../idnest-secure, relative to
the repository root. Defaults: VPS_HOST=vps-dev.idnest.cloud, VPS_PORT=22.
Existing credential files are never overwritten.
EOF
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
esac
[ "$#" -le 2 ] || { usage >&2; exit 2; }

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd "$SCRIPT_DIR/../.." && pwd)
REPO_PARENT=$(CDPATH= cd "$REPO_ROOT/.." && pwd)
DEPLOY_KEYS_DIR=$REPO_PARENT/idnest-secure
VPS_HOST=${1:-vps-dev.idnest.cloud}
VPS_PORT=${2:-22}

case "$VPS_HOST" in
  ""|-*|*[!A-Za-z0-9.-]*) fail "VPS_HOST must be a hostname or IP address" ;;
esac
printf '%s\n' "$VPS_PORT" | grep -Eq '^[1-9][0-9]{0,4}$' \
  || fail "VPS_PORT must be an integer from 1 to 65535"
[ "$VPS_PORT" -le 65535 ] || fail "VPS_PORT must be an integer from 1 to 65535"

for command in chmod dirname grep install mktemp openssl rm ssh-keygen ssh-keyscan; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

umask 077
[ ! -L "$DEPLOY_KEYS_DIR" ] \
  || fail "$DEPLOY_KEYS_DIR must not be a symbolic link"
install -d -m 700 "$DEPLOY_KEYS_DIR"
chmod 700 "$DEPLOY_KEYS_DIR"

for filename in \
  github-deploy-ed25519 \
  github-deploy-ed25519.pub \
  host-release-signing-private.pem \
  host-release-signing-public.pem \
  vps-known-hosts; do
  if [ -e "$DEPLOY_KEYS_DIR/$filename" ] || [ -L "$DEPLOY_KEYS_DIR/$filename" ]; then
    fail "$DEPLOY_KEYS_DIR/$filename already exists; refusing to overwrite credentials"
  fi
done

generation_dir=$(mktemp -d "$DEPLOY_KEYS_DIR/.generate.XXXXXX")
cleanup() {
  case "${generation_dir:-}" in
    "$DEPLOY_KEYS_DIR"/.generate.*) rm -rf -- "$generation_dir" ;;
  esac
}
trap cleanup 0 1 2 15

ssh-keygen -q -t ed25519 -a 64 -N '' \
  -C 'github-deploy@idnest-development' \
  -f "$generation_dir/github-deploy-ed25519"

openssl genpkey -algorithm ED25519 \
  -out "$generation_dir/host-release-signing-private.pem"
openssl pkey \
  -in "$generation_dir/host-release-signing-private.pem" \
  -pubout \
  -out "$generation_dir/host-release-signing-public.pem"

ssh-keyscan -T 10 -p "$VPS_PORT" "$VPS_HOST" \
  > "$generation_dir/vps-known-hosts"
[ -s "$generation_dir/vps-known-hosts" ] \
  || fail "ssh-keyscan returned no host keys for $VPS_HOST:$VPS_PORT"

ssh-keygen -l -f "$generation_dir/github-deploy-ed25519.pub" >/dev/null \
  || fail "generated deployment SSH public key is invalid"
openssl pkey -pubin \
  -in "$generation_dir/host-release-signing-public.pem" \
  -noout >/dev/null \
  || fail "generated release-signing public key is invalid"

install -m 600 \
  "$generation_dir/github-deploy-ed25519" \
  "$DEPLOY_KEYS_DIR/github-deploy-ed25519"
install -m 644 \
  "$generation_dir/github-deploy-ed25519.pub" \
  "$DEPLOY_KEYS_DIR/github-deploy-ed25519.pub"
install -m 600 \
  "$generation_dir/host-release-signing-private.pem" \
  "$DEPLOY_KEYS_DIR/host-release-signing-private.pem"
install -m 644 \
  "$generation_dir/host-release-signing-public.pem" \
  "$DEPLOY_KEYS_DIR/host-release-signing-public.pem"
install -m 600 \
  "$generation_dir/vps-known-hosts" \
  "$DEPLOY_KEYS_DIR/vps-known-hosts"

cleanup
generation_dir=
trap - 0 1 2 15

echo "Development deployment credentials created in: $DEPLOY_KEYS_DIR"
echo "VPS host-key fingerprints (verify through a second trusted channel):"
ssh-keygen -lf "$DEPLOY_KEYS_DIR/vps-known-hosts"
echo "Private keys stay on this workstation and are uploaded only to protected GitHub environment secrets."
echo "Only github-deploy-ed25519.pub and host-release-signing-public.pem are copied to the VPS."
