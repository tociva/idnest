#!/bin/sh
set -eu

fail() {
  echo "Development VPS administrator preparation failed: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  scripts/deploy/prepare-development-vps-admin.sh \
    ROOT_SSH_PRIVATE_KEY [VPS_ADMIN_USER] [VPS_HOST] [VPS_PORT]

Uses the provider-created root login once to create and verify a separate VPS
administrator. The public half of ROOT_SSH_PRIVATE_KEY is authorized for the
new account; the private key never leaves this workstation.

Defaults: VPS_ADMIN_USER=idnest-admin, VPS_HOST=vps-dev.idnest.cloud,
VPS_PORT=22.
EOF
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
esac
[ "$#" -ge 1 ] && [ "$#" -le 4 ] || { usage >&2; exit 2; }

ROOT_SSH_PRIVATE_KEY=$1
VPS_ADMIN_USER=${2:-idnest-admin}
VPS_HOST=${3:-vps-dev.idnest.cloud}
VPS_PORT=${4:-22}

case "$VPS_ADMIN_USER" in
  root|github-deploy) fail "VPS_ADMIN_USER must be a separate administrative account" ;;
  ""|*[!a-z0-9_-]*|[!a-z_]*) fail "VPS_ADMIN_USER is not a valid Linux account name" ;;
esac
case "$VPS_HOST" in
  ""|-*|*[!A-Za-z0-9.-]*) fail "VPS_HOST must be a hostname or IP address" ;;
esac
printf '%s\n' "$VPS_PORT" | grep -Eq '^[1-9][0-9]{0,4}$' \
  || fail "VPS_PORT must be an integer from 1 to 65535"
[ "$VPS_PORT" -le 65535 ] || fail "VPS_PORT must be an integer from 1 to 65535"
[ -f "$ROOT_SSH_PRIVATE_KEY" ] && [ ! -L "$ROOT_SSH_PRIVATE_KEY" ] \
  && [ -s "$ROOT_SSH_PRIVATE_KEY" ] \
  || fail "ROOT_SSH_PRIVATE_KEY must be a non-empty regular file"

for command in dirname grep ssh ssh-keygen; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd "$SCRIPT_DIR/../.." && pwd)
REPO_PARENT=$(CDPATH= cd "$REPO_ROOT/.." && pwd)
DEPLOY_KEYS_DIR=$REPO_PARENT/idnest-secure
KNOWN_HOSTS=$DEPLOY_KEYS_DIR/vps-known-hosts

[ -d "$DEPLOY_KEYS_DIR" ] && [ ! -L "$DEPLOY_KEYS_DIR" ] \
  || fail "$DEPLOY_KEYS_DIR is missing or is not a regular directory; run create-development-credentials.sh first"
[ -f "$KNOWN_HOSTS" ] && [ ! -L "$KNOWN_HOSTS" ] && [ -s "$KNOWN_HOSTS" ] \
  || fail "missing or invalid VPS known-hosts file: $KNOWN_HOSTS"

known_host=$VPS_HOST
if [ "$VPS_PORT" -ne 22 ]; then
  known_host=[$VPS_HOST]:$VPS_PORT
fi
ssh-keygen -F "$known_host" -f "$KNOWN_HOSTS" >/dev/null \
  || fail "$KNOWN_HOSTS has no entry for $known_host; regenerate credentials for this endpoint"

admin_public_key=$(ssh-keygen -y -f "$ROOT_SSH_PRIVATE_KEY") \
  || fail "could not derive the SSH public key"
admin_key_type=${admin_public_key%% *}
admin_key_data=${admin_public_key#* }
[ "$admin_key_data" != "$admin_public_key" ] \
  || fail "ssh-keygen returned an invalid public key"
case "$admin_key_type" in
  ""|*[!A-Za-z0-9@._+-]*) fail "ssh-keygen returned an invalid public key type" ;;
esac
case "$admin_key_data" in
  ""|*' '*|*[!A-Za-z0-9+/=]*) fail "ssh-keygen returned invalid public key data" ;;
esac

ssh \
  -i "$ROOT_SSH_PRIVATE_KEY" \
  -p "$VPS_PORT" \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$KNOWN_HOSTS" \
  "root@$VPS_HOST" \
  sh -s -- "$VPS_ADMIN_USER" "$admin_key_type" "$admin_key_data" <<'REMOTE_SCRIPT'
set -eu

fail() {
  echo "Remote administrator preparation failed: $*" >&2
  exit 1
}

[ "$#" -eq 3 ] || fail "invalid remote arguments"
admin_user=$1
admin_key_type=$2
admin_key_data=$3

case "$admin_user" in
  root|github-deploy|""|*[!a-z0-9_-]*|[!a-z_]*) fail "invalid administrative account" ;;
esac
case "$admin_key_type" in
  ""|*[!A-Za-z0-9@._+-]*) fail "invalid SSH public key type" ;;
esac
case "$admin_key_data" in
  ""|*' '*|*[!A-Za-z0-9+/=]*) fail "invalid SSH public key data" ;;
esac
[ "$(id -u)" -eq 0 ] || fail "the one-time preparation must run through the provider root account"

needs_packages=false
for command in adduser awk getent install ssh-keygen sudo usermod; do
  command -v "$command" >/dev/null 2>&1 || needs_packages=true
done
if [ "$needs_packages" = true ]; then
  command -v apt-get >/dev/null 2>&1 \
    || fail "missing required tools and apt-get is unavailable; this script supports Debian or Ubuntu"
  apt-get update
  env DEBIAN_FRONTEND=noninteractive apt-get install -y \
    adduser gawk openssh-client passwd sudo
fi

for command in adduser awk getent install ssh-keygen sudo usermod; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command after package installation: $command"
done

if ! id "$admin_user" >/dev/null 2>&1; then
  adduser --disabled-password --gecos '' "$admin_user"
fi
[ "$(id -u "$admin_user")" -ne 0 ] || fail "$admin_user must never resolve to UID 0"
usermod -aG sudo "$admin_user"

admin_home=$(getent passwd "$admin_user" | awk -F: 'NR == 1 { print $6 }')
admin_group=$(id -gn "$admin_user")
[ -n "$admin_home" ] && [ -d "$admin_home" ] && [ ! -L "$admin_home" ] \
  || fail "invalid home directory for $admin_user"

[ ! -L "$admin_home/.ssh" ] \
  || fail "$admin_home/.ssh must not be a symbolic link"
install -d -o "$admin_user" -g "$admin_group" -m 700 "$admin_home/.ssh"
authorized_keys=$admin_home/.ssh/authorized_keys
[ ! -L "$authorized_keys" ] || fail "$authorized_keys must not be a symbolic link"
if [ ! -e "$authorized_keys" ]; then
  install -o "$admin_user" -g "$admin_group" -m 600 /dev/null "$authorized_keys"
fi
[ -f "$authorized_keys" ] || fail "$authorized_keys is not a regular file"

key_file=$(mktemp)
cleanup() {
  rm -f -- "$key_file"
}
trap cleanup 0 1 2 15

printf '%s %s\n' "$admin_key_type" "$admin_key_data" > "$key_file"
ssh-keygen -l -f "$key_file" >/dev/null || fail "invalid administrative SSH public key"
if ! awk -v key_type="$admin_key_type" -v key_data="$admin_key_data" \
  '$1 == key_type && $2 == key_data { found=1 } END { exit !found }' \
  "$authorized_keys"; then
  printf '%s %s %s@idnest-development\n' \
    "$admin_key_type" "$admin_key_data" "$admin_user" >> "$authorized_keys"
fi
chown "$admin_user:$admin_group" "$authorized_keys"
chmod 600 "$authorized_keys"

cleanup
key_file=
trap - 0 1 2 15

echo "Administrative account prepared: $admin_user"
REMOTE_SCRIPT

echo "Set the sudo password for $VPS_ADMIN_USER in the encrypted SSH prompt."
ssh \
  -tt \
  -i "$ROOT_SSH_PRIVATE_KEY" \
  -p "$VPS_PORT" \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$KNOWN_HOSTS" \
  "root@$VPS_HOST" \
  passwd "$VPS_ADMIN_USER"

echo "Verify the same sudo password in the encrypted SSH prompt."
ssh \
  -tt \
  -i "$ROOT_SSH_PRIVATE_KEY" \
  -p "$VPS_PORT" \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$KNOWN_HOSTS" \
  "$VPS_ADMIN_USER@$VPS_HOST" \
  'test "$(id -u)" -ne 0 && sudo -v && sudo true'

echo "Verified non-root SSH and sudo access for: $VPS_ADMIN_USER@$VPS_HOST"
echo "The provider root account is not used by subsequent deployment scripts."
echo "Next run: scripts/deploy/transfer-development-vps-bootstrap.sh $VPS_ADMIN_USER $ROOT_SSH_PRIVATE_KEY $VPS_HOST $VPS_PORT"
