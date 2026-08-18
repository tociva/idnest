#!/bin/sh
set -eu

fail() {
  echo "Development Origin CA installation failed: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  scripts/deploy/install-development-origin-ca.sh \
    CLOUDFLARE_FILES_DIR VPS_ADMIN_USER VPS_ADMIN_SSH_KEY \
    [VPS_HOST] [VPS_PORT]

Validates origin-cert.pem, origin-key.pem, and origin-ca.pem from the supplied
directory, securely transfers them to the development VPS, installs them under
/etc/idnest/tls, and verifies the certificate's four development hostnames.

Defaults: VPS_HOST=vps-dev.idnest.cloud, VPS_PORT=22.
VPS_ADMIN_USER must be a non-root account with sudo access.
EOF
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
esac
[ "$#" -ge 3 ] && [ "$#" -le 5 ] || { usage >&2; exit 2; }

CLOUDFLARE_FILES_DIR=$1
VPS_ADMIN_USER=$2
VPS_ADMIN_SSH_KEY=$3
VPS_HOST=${4:-vps-dev.idnest.cloud}
VPS_PORT=${5:-22}

case "$VPS_ADMIN_USER" in
  root|github-deploy) fail "VPS_ADMIN_USER must be a separate non-root administrative account" ;;
  ""|*[!a-z0-9_-]*|[!a-z_]*) fail "VPS_ADMIN_USER is not a valid Linux account name" ;;
esac
case "$VPS_HOST" in
  ""|-*|*[!A-Za-z0-9.-]*) fail "VPS_HOST must be a hostname or IP address" ;;
esac
printf '%s\n' "$VPS_PORT" | grep -Eq '^[1-9][0-9]{0,4}$' \
  || fail "VPS_PORT must be an integer from 1 to 65535"
[ "$VPS_PORT" -le 65535 ] || fail "VPS_PORT must be an integer from 1 to 65535"
[ -d "$CLOUDFLARE_FILES_DIR" ] && [ ! -L "$CLOUDFLARE_FILES_DIR" ] \
  || fail "CLOUDFLARE_FILES_DIR must be a regular directory"
[ -f "$VPS_ADMIN_SSH_KEY" ] && [ ! -L "$VPS_ADMIN_SSH_KEY" ] \
  && [ -s "$VPS_ADMIN_SSH_KEY" ] \
  || fail "VPS_ADMIN_SSH_KEY must be a non-empty regular file"

for command in cmp dirname grep mktemp openssl rm scp ssh ssh-keygen; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd "$SCRIPT_DIR/../.." && pwd)
REPO_PARENT=$(CDPATH= cd "$REPO_ROOT/.." && pwd)
DEPLOY_KEYS_DIR=$REPO_PARENT/idnest-secure
KNOWN_HOSTS=$DEPLOY_KEYS_DIR/vps-known-hosts
ORIGIN_CERT=$CLOUDFLARE_FILES_DIR/origin-cert.pem
ORIGIN_KEY=$CLOUDFLARE_FILES_DIR/origin-key.pem
ORIGIN_CA=$CLOUDFLARE_FILES_DIR/origin-ca.pem

[ -d "$DEPLOY_KEYS_DIR" ] && [ ! -L "$DEPLOY_KEYS_DIR" ] \
  || fail "$DEPLOY_KEYS_DIR is missing or is not a regular directory; run create-development-credentials.sh first"
[ -f "$KNOWN_HOSTS" ] && [ ! -L "$KNOWN_HOSTS" ] && [ -s "$KNOWN_HOSTS" ] \
  || fail "missing or invalid VPS known-hosts file: $KNOWN_HOSTS"
for required_file in "$ORIGIN_CERT" "$ORIGIN_KEY" "$ORIGIN_CA"; do
  [ -f "$required_file" ] && [ ! -L "$required_file" ] && [ -s "$required_file" ] \
    || fail "missing or invalid Cloudflare certificate file: $required_file"
done

known_host=$VPS_HOST
if [ "$VPS_PORT" -ne 22 ]; then
  known_host=[$VPS_HOST]:$VPS_PORT
fi
ssh-keygen -F "$known_host" -f "$KNOWN_HOSTS" >/dev/null \
  || fail "$KNOWN_HOSTS has no entry for $known_host; regenerate credentials for this endpoint"

umask 077
validation_dir=$(mktemp -d "${TMPDIR:-/tmp}/idnest-origin-ca.XXXXXX")
cleanup() {
  case "${validation_dir:-}" in
    */idnest-origin-ca.*) rm -rf -- "$validation_dir" ;;
  esac
}
trap cleanup 0 1 2 15

openssl x509 -in "$ORIGIN_CERT" -noout >/dev/null \
  || fail "$ORIGIN_CERT is not a valid PEM certificate"
openssl x509 -in "$ORIGIN_CA" -noout >/dev/null \
  || fail "$ORIGIN_CA is not a valid PEM certificate"
openssl pkey -in "$ORIGIN_KEY" -noout -check >/dev/null \
  || fail "$ORIGIN_KEY is not a valid private key"
openssl x509 -in "$ORIGIN_CERT" -pubkey -noout \
  > "$validation_dir/certificate-public-key.pem"
openssl pkey -in "$ORIGIN_KEY" -pubout \
  > "$validation_dir/private-key-public-key.pem"
cmp -s \
  "$validation_dir/certificate-public-key.pem" \
  "$validation_dir/private-key-public-key.pem" \
  || fail "origin-cert.pem and origin-key.pem do not match"
openssl verify -CAfile "$ORIGIN_CA" "$ORIGIN_CERT" >/dev/null \
  || fail "origin-cert.pem cannot be verified with origin-ca.pem"
chmod 600 "$ORIGIN_KEY"

ssh \
  -i "$VPS_ADMIN_SSH_KEY" \
  -p "$VPS_PORT" \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$KNOWN_HOSTS" \
  "$VPS_ADMIN_USER@$VPS_HOST" \
  'staging="$HOME/idnest-bootstrap"
   test ! -L "$staging" && install -d -m 700 "$staging" || exit 1
   for file in origin-cert.pem origin-key.pem origin-ca.pem; do
     test ! -L "$staging/$file" || exit 1
   done'

scp \
  -i "$VPS_ADMIN_SSH_KEY" \
  -P "$VPS_PORT" \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$KNOWN_HOSTS" \
  "$ORIGIN_CERT" \
  "$ORIGIN_KEY" \
  "$ORIGIN_CA" \
  "$VPS_ADMIN_USER@$VPS_HOST:idnest-bootstrap/"

ssh \
  -tt \
  -i "$VPS_ADMIN_SSH_KEY" \
  -p "$VPS_PORT" \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$KNOWN_HOSTS" \
  "$VPS_ADMIN_USER@$VPS_HOST" \
  'set -eu
   staging="$HOME/idnest-bootstrap"
   chmod 600 "$staging/origin-key.pem"
   sudo test -d /etc/idnest/tls
   sudo install -o root -g root -m 644 \
     "$staging/origin-cert.pem" /etc/idnest/tls/origin-cert.pem
   sudo install -o root -g idnest-tls -m 640 \
     "$staging/origin-key.pem" /etc/idnest/tls/origin-key.pem
   sudo install -o root -g root -m 644 \
     "$staging/origin-ca.pem" /etc/idnest/tls/origin-ca.pem
   sudo openssl x509 -in /etc/idnest/tls/origin-cert.pem -noout \
     -subject -issuer -dates -ext subjectAltName
   sudo openssl pkey -in /etc/idnest/tls/origin-key.pem -noout -check
   for hostname in auth-dev.idnest.cloud admin-dev.idnest.cloud \
     hydra-dev.idnest.cloud kratos-dev.idnest.cloud; do
     sudo openssl x509 -in /etc/idnest/tls/origin-cert.pem \
       -noout -checkhost "$hostname"
   done
   sudo stat -c "%U:%G %a %n" /etc/idnest/tls/origin-*.pem
   rm -f -- \
     "$staging/origin-cert.pem" \
     "$staging/origin-key.pem" \
     "$staging/origin-ca.pem"'

cleanup
validation_dir=
trap - 0 1 2 15

echo "Cloudflare Origin CA certificate installed and verified on $VPS_HOST."
