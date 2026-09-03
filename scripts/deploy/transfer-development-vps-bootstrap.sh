#!/bin/sh
set -eu

fail() {
  echo "Development VPS bootstrap transfer failed: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  scripts/deploy/transfer-development-vps-bootstrap.sh \
    VPS_ADMIN_USER VPS_ADMIN_SSH_KEY DEVELOPMENT_ENV [VPS_HOST] [VPS_PORT]

Packages the development VPS bootstrap payload, stores the archive under
../idnest-secure, and transfers the archive, VPS bootstrap runner, checksum,
and two required public keys. Every upload is covered by the remote checksum
verification. Application and identity secrets are not transferred.

VPS_HOST and VPS_PORT default to the values in DEVELOPMENT_ENV.
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

VPS_ADMIN_USER=$1
VPS_ADMIN_SSH_KEY=$2
DEVELOPMENT_ENV=$3

case "$VPS_ADMIN_USER" in
  root|idnest-deploy) fail "VPS_ADMIN_USER must be a separate non-root administrative account" ;;
  ""|*[!a-z0-9_-]*|[!a-z_]*) fail "VPS_ADMIN_USER is not a valid Linux account name" ;;
esac
[ -f "$VPS_ADMIN_SSH_KEY" ] && [ ! -L "$VPS_ADMIN_SSH_KEY" ] && [ -s "$VPS_ADMIN_SSH_KEY" ] \
  || fail "VPS_ADMIN_SSH_KEY must be a non-empty regular file"
[ -f "$DEVELOPMENT_ENV" ] && [ ! -L "$DEVELOPMENT_ENV" ] && [ -s "$DEVELOPMENT_ENV" ] \
  || fail "DEVELOPMENT_ENV must be a non-empty regular file"

for command in awk dirname grep install mktemp rm scp shasum ssh ssh-keygen stat tar uname; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd "$SCRIPT_DIR/../.." && pwd)
REPO_PARENT=$(CDPATH= cd "$REPO_ROOT/.." && pwd)
DEPLOY_KEYS_DIR=$REPO_PARENT/idnest-secure
ARCHIVE_NAME=idnest-development-vps-bootstrap.tar.gz
ARCHIVE_PATH=$DEPLOY_KEYS_DIR/$ARCHIVE_NAME
CHECKSUM_PATH=$ARCHIVE_PATH.sha256
KNOWN_HOSTS=$DEPLOY_KEYS_DIR/vps-known-hosts
SIGNING_PUBLIC_KEY=$DEPLOY_KEYS_DIR/host-release-signing-public.pem
DEPLOY_SSH_PUBLIC_KEY=$DEPLOY_KEYS_DIR/idnest-deploy-ed25519.pub
BOOTSTRAP_RUNNER_NAME=bootstrap-development-vps.sh
BOOTSTRAP_RUNNER_PATH=$REPO_ROOT/scripts/deploy/vps/$BOOTSTRAP_RUNNER_NAME

file_mode() {
  if [ "$(uname -s)" = Darwin ]; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

[ "$(file_mode "$DEVELOPMENT_ENV")" = 600 ] \
  || fail "DEVELOPMENT_ENV must have mode 600"

dotenv_value() {
  awk -v wanted="$1" '
    index($0, "=") > 0 {
      key = substr($0, 1, index($0, "=") - 1)
      if (key == wanted) {
        value = substr($0, index($0, "=") + 1)
        if (value ~ /^".*"$/ || value ~ /^\047.*\047$/) {
          value = substr(value, 2, length(value) - 2)
        }
        print value
        exit
      }
    }
  ' "$DEVELOPMENT_ENV"
}

VPS_HOST=${4:-$(dotenv_value VPS_HOST)}
VPS_PORT=${5:-$(dotenv_value VPS_PORT)}
case "$VPS_HOST" in
  ""|-*|*[!A-Za-z0-9.-]*) fail "VPS_HOST must be a hostname or IP address" ;;
esac
printf '%s\n' "$VPS_PORT" | grep -Eq '^[1-9][0-9]{0,4}$' \
  || fail "VPS_PORT must be an integer from 1 to 65535"
[ "$VPS_PORT" -le 65535 ] || fail "VPS_PORT must be an integer from 1 to 65535"

[ -d "$DEPLOY_KEYS_DIR" ] && [ ! -L "$DEPLOY_KEYS_DIR" ] \
  || fail "$DEPLOY_KEYS_DIR is missing or is not a regular directory; run create-development-credentials.sh first"
for required_file in "$KNOWN_HOSTS" "$SIGNING_PUBLIC_KEY" "$DEPLOY_SSH_PUBLIC_KEY"; do
  [ -f "$required_file" ] && [ ! -L "$required_file" ] && [ -s "$required_file" ] \
    || fail "missing required credential file: $required_file"
done
[ -f "$BOOTSTRAP_RUNNER_PATH" ] && [ ! -L "$BOOTSTRAP_RUNNER_PATH" ] \
  && [ -s "$BOOTSTRAP_RUNNER_PATH" ] && [ -x "$BOOTSTRAP_RUNNER_PATH" ] \
  || fail "missing or invalid VPS bootstrap runner: $BOOTSTRAP_RUNNER_PATH"
for generated_file in "$ARCHIVE_PATH" "$CHECKSUM_PATH"; do
  [ ! -L "$generated_file" ] || fail "refusing to replace symbolic link: $generated_file"
done

known_host=$VPS_HOST
if [ "$VPS_PORT" -ne 22 ]; then
  known_host=[$VPS_HOST]:$VPS_PORT
fi
ssh-keygen -F "$known_host" -f "$KNOWN_HOSTS" >/dev/null \
  || fail "$KNOWN_HOSTS has no entry for $known_host; regenerate credentials for this endpoint"

set -- \
  scripts/deploy/vps/provision-host.sh \
  scripts/deploy/vps/compose.auth.yaml \
  scripts/deploy/vps/compose.admin.yaml \
  scripts/deploy/vps/compose.idnest.yaml \
  scripts/deploy/vps/Dockerfile.kratos \
  scripts/deploy/vps/deploy-idnest-app.sh \
  scripts/deploy/vps/deploy-idnest-infra.sh \
  scripts/deploy/vps/deploy-idnest-auth.sh \
  scripts/deploy/vps/deploy-idnest-admin.sh \
  scripts/deploy/vps/rollback-idnest-app.sh \
  scripts/deploy/vps/rollback-idnest-auth.sh \
  scripts/deploy/vps/rollback-idnest-admin.sh \
  scripts/deploy/vps/validate-app-env.sh \
  scripts/deploy/vps/activate-host-release.sh \
  scripts/deploy/vps/process-idnest-release-queue.sh \
  scripts/deploy/vps/submit-idnest-release.sh \
  scripts/deploy/vps/wait-idnest-release.sh \
  scripts/deploy/vps/idnest-release-queue.path \
  scripts/deploy/vps/idnest-release-queue.service \
  scripts/deploy/vps/validate-development-host.sh \
  scripts/deploy/vps/auth.conf.example \
  scripts/deploy/vps/admin.conf.example \
  scripts/deploy/vps/idnest.conf.example \
  scripts/docker/render-kratos-config.sh \
  config/kratos.tpl.yml \
  config/kratos/identity.schema.json \
  config/kratos/oidc.apple.mapper.jsonnet \
  config/kratos/oidc.google.mapper.jsonnet

for payload_file in "$@"; do
  [ -f "$REPO_ROOT/$payload_file" ] && [ ! -L "$REPO_ROOT/$payload_file" ] \
    || fail "invalid bootstrap payload file: $payload_file"
done

umask 077
generation_dir=$(mktemp -d "$DEPLOY_KEYS_DIR/.bootstrap.XXXXXX")
cleanup() {
  case "${generation_dir:-}" in
    "$DEPLOY_KEYS_DIR"/.bootstrap.*) rm -rf -- "$generation_dir" ;;
  esac
}
trap cleanup 0 1 2 15

temporary_archive=$generation_dir/$ARCHIVE_NAME
COPYFILE_DISABLE=1
export COPYFILE_DISABLE
(cd "$REPO_ROOT" && tar -czf "$temporary_archive" "$@")
archive_digest=$(shasum -a 256 "$temporary_archive" | awk '{print $1}')
runner_digest=$(shasum -a 256 "$BOOTSTRAP_RUNNER_PATH" | awk '{print $1}')
signing_public_key_digest=$(shasum -a 256 "$SIGNING_PUBLIC_KEY" | awk '{print $1}')
deploy_public_key_digest=$(shasum -a 256 "$DEPLOY_SSH_PUBLIC_KEY" | awk '{print $1}')
{
  printf '%s  %s\n' "$archive_digest" "$ARCHIVE_NAME"
  printf '%s  %s\n' "$runner_digest" "$BOOTSTRAP_RUNNER_NAME"
  printf '%s  %s\n' "$signing_public_key_digest" host-release-signing-public.pem
  printf '%s  %s\n' "$deploy_public_key_digest" idnest-deploy-ed25519.pub
} > "$generation_dir/$ARCHIVE_NAME.sha256"

install -m 600 "$temporary_archive" "$ARCHIVE_PATH"
install -m 600 "$generation_dir/$ARCHIVE_NAME.sha256" "$CHECKSUM_PATH"

ssh \
  -i "$VPS_ADMIN_SSH_KEY" \
  -p "$VPS_PORT" \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$KNOWN_HOSTS" \
  "$VPS_ADMIN_USER@$VPS_HOST" \
  'staging="$HOME/idnest-bootstrap"
   test ! -L "$staging" && install -d -m 700 "$staging" || exit 1
   for file in idnest-development-vps-bootstrap.tar.gz idnest-development-vps-bootstrap.tar.gz.sha256 bootstrap-development-vps.sh host-release-signing-public.pem idnest-deploy-ed25519.pub; do
     test ! -L "$staging/$file" || exit 1
   done'

set -- \
  "$ARCHIVE_PATH" \
  "$CHECKSUM_PATH" \
  "$BOOTSTRAP_RUNNER_PATH" \
  "$SIGNING_PUBLIC_KEY" \
  "$DEPLOY_SSH_PUBLIC_KEY"
scp \
  -i "$VPS_ADMIN_SSH_KEY" \
  -P "$VPS_PORT" \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$KNOWN_HOSTS" \
  "$@" \
  "$VPS_ADMIN_USER@$VPS_HOST:idnest-bootstrap/"

ssh \
  -i "$VPS_ADMIN_SSH_KEY" \
  -p "$VPS_PORT" \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$KNOWN_HOSTS" \
  "$VPS_ADMIN_USER@$VPS_HOST" \
  'cd "$HOME/idnest-bootstrap"
   chmod 700 bootstrap-development-vps.sh
   sha256sum --check idnest-development-vps-bootstrap.tar.gz.sha256'

cleanup
generation_dir=
trap - 0 1 2 15

echo "Development bootstrap payload transferred and verified."
echo "Remote staging directory: $VPS_ADMIN_USER@$VPS_HOST:~/idnest-bootstrap"
echo "On the VPS, run: ~/idnest-bootstrap/bootstrap-development-vps.sh"
