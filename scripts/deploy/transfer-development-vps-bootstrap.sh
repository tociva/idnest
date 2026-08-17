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
    VPS_ADMIN_USER VPS_ADMIN_SSH_KEY [VPS_HOST] [VPS_PORT]

Packages the development VPS bootstrap payload, stores the archive under
../idnest-secure, and transfers the archive, VPS bootstrap runner, checksum,
and two required public keys. The uploaded checksums are verified on the VPS.
When tmp/vps.env exists, compatible Idnest runtime values are securely staged for
first-bootstrap import without adding that file to the archive.

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
[ "$#" -ge 2 ] && [ "$#" -le 4 ] || { usage >&2; exit 2; }

VPS_ADMIN_USER=$1
VPS_ADMIN_SSH_KEY=$2
VPS_HOST=${3:-vps-dev.idnest.cloud}
VPS_PORT=${4:-22}

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
[ -f "$VPS_ADMIN_SSH_KEY" ] && [ ! -L "$VPS_ADMIN_SSH_KEY" ] && [ -s "$VPS_ADMIN_SSH_KEY" ] \
  || fail "VPS_ADMIN_SSH_KEY must be a non-empty regular file"

for command in awk dirname grep install mktemp rm scp shasum sort ssh ssh-keygen stat tar uname; do
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
DEPLOY_SSH_PUBLIC_KEY=$DEPLOY_KEYS_DIR/github-deploy-ed25519.pub
BOOTSTRAP_RUNNER_NAME=bootstrap-development-vps.sh
BOOTSTRAP_RUNNER_PATH=$REPO_ROOT/scripts/deploy/vps/$BOOTSTRAP_RUNNER_NAME
VPS_RUNTIME_ENV=$REPO_ROOT/tmp/vps.env
IDNEST_ENV_TEMPLATE=$REPO_ROOT/scripts/deploy/env/idnest.env.example
RUNTIME_IMPORT_NAME=idnest.env.import
RUNTIME_IMPORT_CHECKSUM_NAME=$RUNTIME_IMPORT_NAME.sha256
RUNTIME_IMPORT_ENABLED=false

file_mode() {
  if [ "$(uname -s)" = Darwin ]; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

[ -d "$DEPLOY_KEYS_DIR" ] && [ ! -L "$DEPLOY_KEYS_DIR" ] \
  || fail "$DEPLOY_KEYS_DIR is missing or is not a regular directory; run create-development-credentials.sh first"
for required_file in "$KNOWN_HOSTS" "$SIGNING_PUBLIC_KEY" "$DEPLOY_SSH_PUBLIC_KEY"; do
  [ -f "$required_file" ] && [ ! -L "$required_file" ] && [ -s "$required_file" ] \
    || fail "missing required credential file: $required_file"
done
[ -f "$BOOTSTRAP_RUNNER_PATH" ] && [ ! -L "$BOOTSTRAP_RUNNER_PATH" ] \
  && [ -s "$BOOTSTRAP_RUNNER_PATH" ] && [ -x "$BOOTSTRAP_RUNNER_PATH" ] \
  || fail "missing or invalid VPS bootstrap runner: $BOOTSTRAP_RUNNER_PATH"
[ -f "$IDNEST_ENV_TEMPLATE" ] && [ ! -L "$IDNEST_ENV_TEMPLATE" ] && [ -s "$IDNEST_ENV_TEMPLATE" ] \
  || fail "missing or invalid Idnest environment template: $IDNEST_ENV_TEMPLATE"

if [ -e "$VPS_RUNTIME_ENV" ] || [ -L "$VPS_RUNTIME_ENV" ]; then
  [ -f "$VPS_RUNTIME_ENV" ] && [ ! -L "$VPS_RUNTIME_ENV" ] && [ -s "$VPS_RUNTIME_ENV" ] \
    || fail "$VPS_RUNTIME_ENV must be a non-empty regular file"
  [ "$(file_mode "$VPS_RUNTIME_ENV")" = 600 ] \
    || fail "$VPS_RUNTIME_ENV must have mode 600"

  awk -F= '
    FNR == NR {
      if ($0 ~ /^[A-Za-z_][A-Za-z0-9_]*=/) known[$1] = 1
      next
    }
    /^[[:space:]]*($|#)/ { next }
    /^[A-Za-z_][A-Za-z0-9_]*=/ {
      key=$1
      if (!(key in known)) {
        printf "Unsupported key in tmp/vps.env: %s\n", key > "/dev/stderr"
        failed=1
      }
      if (seen[key]++) {
        printf "Duplicate key in tmp/vps.env: %s\n", key > "/dev/stderr"
        failed=1
      }
      next
    }
    {
      printf "Malformed line in tmp/vps.env: %d\n", FNR > "/dev/stderr"
      failed=1
    }
    END { exit failed }
  ' "$IDNEST_ENV_TEMPLATE" "$VPS_RUNTIME_ENV" \
    || fail "$VPS_RUNTIME_ENV does not satisfy the Idnest environment contract"
  "$REPO_ROOT/scripts/deploy/vps/validate-app-env.sh" "$VPS_RUNTIME_ENV" >/dev/null \
    || fail "$VPS_RUNTIME_ENV contains duplicate, malformed, or placeholder values"
  awk '
    /^[[:space:]]*KRATOS_CIPHER_SECRET[[:space:]]*=/ {
      value=$0
      sub(/^[^=]*=/, "", value)
      sub(/^[[:space:]]*/, "", value)
      sub(/[[:space:]]*$/, "", value)
      if (value ~ /^".*"$/ || value ~ /^\047.*\047$/) {
        value=substr(value, 2, length(value) - 2)
      }
      found=1
      exit length(value) == 32 ? 0 : 1
    }
    END { if (!found) exit 1 }
  ' "$VPS_RUNTIME_ENV" \
    || fail "$VPS_RUNTIME_ENV must contain a 32-character KRATOS_CIPHER_SECRET"
  RUNTIME_IMPORT_ENABLED=true
fi
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
  scripts/deploy/vps/auth.conf.example \
  scripts/deploy/vps/admin.conf.example \
  scripts/deploy/vps/idnest.conf.example \
  scripts/deploy/env/idnest.env.example \
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
(cd "$REPO_ROOT" && tar -czf "$temporary_archive" "$@")
archive_digest=$(shasum -a 256 "$temporary_archive" | awk '{print $1}')
runner_digest=$(shasum -a 256 "$BOOTSTRAP_RUNNER_PATH" | awk '{print $1}')
{
  printf '%s  %s\n' "$archive_digest" "$ARCHIVE_NAME"
  printf '%s  %s\n' "$runner_digest" "$BOOTSTRAP_RUNNER_NAME"
} > "$generation_dir/$ARCHIVE_NAME.sha256"

if [ "$RUNTIME_IMPORT_ENABLED" = true ]; then
  awk '
    BEGIN {
      count=split("HYDRA_DSN HYDRA_SECRETS_SYSTEM KRATOS_DSN KRATOS_CSRF_COOKIE_SECRET KRATOS_CIPHER_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET APPLE_CLIENT_ID APPLE_TEAM_ID APPLE_PRIVATE_KEY_ID APPLE_PRIVATE_KEY", keys, " ")
      for (idx=1; idx<=count; idx++) portable[keys[idx]]=1
    }
    FNR == NR {
      if ($0 ~ /^[A-Za-z_][A-Za-z0-9_]*=/) {
        separator=index($0, "=")
        key=substr($0, 1, separator - 1)
        if (key in portable) imported[key]=substr($0, separator + 1)
      }
      next
    }
    /^[A-Za-z_][A-Za-z0-9_]*=/ {
      separator=index($0, "=")
      key=substr($0, 1, separator - 1)
      if (key in imported) {
        print key "=" imported[key]
        next
      }
    }
    { print }
  ' "$VPS_RUNTIME_ENV" "$IDNEST_ENV_TEMPLATE" > "$generation_dir/$RUNTIME_IMPORT_NAME"
  "$REPO_ROOT/scripts/deploy/vps/validate-app-env.sh" \
    "$generation_dir/$RUNTIME_IMPORT_NAME" >/dev/null \
    || fail "the generated Idnest runtime import is incomplete or invalid"
  runtime_import_digest=$(shasum -a 256 "$generation_dir/$RUNTIME_IMPORT_NAME" | awk '{print $1}')
  printf '%s  %s\n' "$runtime_import_digest" "$RUNTIME_IMPORT_NAME" \
    > "$generation_dir/$RUNTIME_IMPORT_CHECKSUM_NAME"
fi

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
   for file in idnest-development-vps-bootstrap.tar.gz idnest-development-vps-bootstrap.tar.gz.sha256 bootstrap-development-vps.sh host-release-signing-public.pem github-deploy-ed25519.pub idnest.env.import idnest.env.import.sha256; do
     test ! -L "$staging/$file" || exit 1
   done
   rm -f -- "$staging/idnest.env.import" "$staging/idnest.env.import.sha256"'

set -- \
  "$ARCHIVE_PATH" \
  "$CHECKSUM_PATH" \
  "$BOOTSTRAP_RUNNER_PATH" \
  "$SIGNING_PUBLIC_KEY" \
  "$DEPLOY_SSH_PUBLIC_KEY"
if [ "$RUNTIME_IMPORT_ENABLED" = true ]; then
  set -- "$@" \
    "$generation_dir/$RUNTIME_IMPORT_NAME" \
    "$generation_dir/$RUNTIME_IMPORT_CHECKSUM_NAME"
fi

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
   sha256sum --check idnest-development-vps-bootstrap.tar.gz.sha256
   if [ -e idnest.env.import ] || [ -e idnest.env.import.sha256 ]; then
     test -f idnest.env.import && test ! -L idnest.env.import
     test -f idnest.env.import.sha256 && test ! -L idnest.env.import.sha256
     sha256sum --check idnest.env.import.sha256
   fi'

cleanup
generation_dir=
trap - 0 1 2 15

echo "Development bootstrap payload transferred and verified."
echo "Remote staging directory: $VPS_ADMIN_USER@$VPS_HOST:~/idnest-bootstrap"
if [ "$RUNTIME_IMPORT_ENABLED" = true ]; then
  echo "Compatible values from tmp/vps.env were staged for Idnest runtime import."
fi
echo "On the VPS, run: ~/idnest-bootstrap/bootstrap-development-vps.sh"
