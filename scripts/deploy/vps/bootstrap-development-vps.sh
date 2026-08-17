#!/bin/sh
set -eu

fail() {
  echo "Development VPS bootstrap failed: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: bootstrap-development-vps.sh [--validate-config]

With no arguments, verifies and extracts the transferred development payload,
installs the minimum host packages and templates, and provisions the deployment
user and release processor.

Use --validate-config after editing the VPS-owned files under /etc/idnest.
Run this script as a non-root administrative account with sudo access.
EOF
}

MODE=bootstrap
case "${1:-}" in
  "") ;;
  --validate-config) MODE=validate-config ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
[ "$#" -le 1 ] || { usage >&2; exit 2; }

[ "$(id -u)" -ne 0 ] \
  || fail "do not run this script as root; use a non-root account with sudo access"
[ "$(id -un)" != github-deploy ] \
  || fail "github-deploy is deployment-only; use a separate non-root administrative account"

for command in dirname id sha256sum sudo; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
ARCHIVE_NAME=idnest-development-vps-bootstrap.tar.gz
CHECKSUM_NAME=$ARCHIVE_NAME.sha256
ARCHIVE_PATH=$SCRIPT_DIR/$ARCHIVE_NAME
CHECKSUM_PATH=$SCRIPT_DIR/$CHECKSUM_NAME
SIGNING_PUBLIC_KEY=$SCRIPT_DIR/host-release-signing-public.pem
DEPLOY_SSH_PUBLIC_KEY=$SCRIPT_DIR/github-deploy-ed25519.pub
REPOSITORY_DIR=$SCRIPT_DIR/repository
SCRIPT_PATH=$SCRIPT_DIR/bootstrap-development-vps.sh

[ -f "$SCRIPT_PATH" ] && [ ! -L "$SCRIPT_PATH" ] \
  || fail "the bootstrap script must be a regular file, not a symbolic link"
for required_file in \
  "$ARCHIVE_PATH" \
  "$CHECKSUM_PATH" \
  "$SIGNING_PUBLIC_KEY" \
  "$DEPLOY_SSH_PUBLIC_KEY"; do
  [ -f "$required_file" ] && [ ! -L "$required_file" ] && [ -s "$required_file" ] \
    || fail "missing or invalid transferred file: $required_file"
done

cd "$SCRIPT_DIR"
sha256sum --check "$CHECKSUM_NAME" \
  || fail "transferred bootstrap checksum verification failed"
sudo -v

if [ "$MODE" = validate-config ]; then
  VALIDATOR=/usr/local/sbin/validate-ory-app-env
  [ -x "$VALIDATOR" ] || fail "host provisioning has not installed $VALIDATOR"

  for config_file in \
    /etc/idnest/auth-app.env \
    /etc/idnest/admin-app.env \
    /etc/idnest/ory.env \
    /etc/idnest/auth.conf \
    /etc/idnest/admin.conf \
    /etc/idnest/ory.conf; do
    sudo "$VALIDATOR" "$config_file"
  done

  echo "Development VPS configuration validation passed."
  exit 0
fi

for command in apt-get env install mktemp mv rm stat tar; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

umask 077
extraction_dir=$(mktemp -d "$SCRIPT_DIR/.repository.XXXXXX")
cleanup() {
  case "${extraction_dir:-}" in
    "$SCRIPT_DIR"/.repository.*) rm -rf -- "$extraction_dir" ;;
  esac
}
trap cleanup 0 1 2 15

tar -xzf "$ARCHIVE_PATH" -C "$extraction_dir"
[ -f "$extraction_dir/scripts/deploy/vps/provision-host.sh" ] \
  && [ ! -L "$extraction_dir/scripts/deploy/vps/provision-host.sh" ] \
  || fail "the extracted payload does not contain a valid host provisioner"

if [ -e "$REPOSITORY_DIR" ] || [ -L "$REPOSITORY_DIR" ]; then
  [ -d "$REPOSITORY_DIR" ] && [ ! -L "$REPOSITORY_DIR" ] \
    || fail "$REPOSITORY_DIR exists but is not a regular directory"
  [ "$(stat -c '%u' "$REPOSITORY_DIR")" -eq "$(id -u)" ] \
    || fail "$REPOSITORY_DIR is not owned by the current account"
  rm -rf -- "$REPOSITORY_DIR"
fi
mv "$extraction_dir" "$REPOSITORY_DIR"
extraction_dir=
trap - 0 1 2 15

sudo apt-get update
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y \
  adduser ca-certificates coreutils curl grep openssl tar util-linux

for command in cat curl grep systemctl; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command after package installation: $command"
done

install_docker_engine() {
  [ -r /etc/os-release ] || fail "cannot detect the VPS operating system"
  # /etc/os-release is a root-owned operating-system interface on the VPS.
  . /etc/os-release

  case "${ID:-}" in
    ubuntu)
      docker_distribution=ubuntu
      docker_codename=${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}
      ;;
    debian)
      docker_distribution=debian
      docker_codename=${VERSION_CODENAME:-}
      ;;
    *) fail "automatic Docker installation supports only Debian or Ubuntu" ;;
  esac
  case "$docker_codename" in
    ""|*[!A-Za-z0-9._-]*) fail "invalid operating-system codename: $docker_codename" ;;
  esac

  command -v dpkg >/dev/null 2>&1 || fail "dpkg is required to install Docker Engine"
  command -v dpkg-query >/dev/null 2>&1 || fail "dpkg-query is required to install Docker Engine"
  docker_architecture=$(dpkg --print-architecture)
  case "$docker_architecture" in
    ""|*[!A-Za-z0-9._-]*) fail "invalid Debian architecture: $docker_architecture" ;;
  esac

  for conflicting_package in \
    docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc; do
    if dpkg-query -W -f='${db:Status-Status}' "$conflicting_package" 2>/dev/null \
      | grep -qx installed; then
      fail "conflicting package is installed: $conflicting_package"
    fi
  done

  docker_setup_dir=$(mktemp -d "$SCRIPT_DIR/.docker-setup.XXXXXX")
  cleanup_docker_setup() {
    case "${docker_setup_dir:-}" in
      "$SCRIPT_DIR"/.docker-setup.*) rm -rf -- "$docker_setup_dir" ;;
    esac
  }
  trap cleanup_docker_setup 0 1 2 15

  curl -fsSL \
    "https://download.docker.com/linux/$docker_distribution/gpg" \
    -o "$docker_setup_dir/docker.asc"
  [ -s "$docker_setup_dir/docker.asc" ] || fail "Docker repository signing key download was empty"

  cat > "$docker_setup_dir/docker.sources" <<EOF
Types: deb
URIs: https://download.docker.com/linux/$docker_distribution
Suites: $docker_codename
Components: stable
Architectures: $docker_architecture
Signed-By: /etc/apt/keyrings/docker.asc
EOF

  sudo install -d -o root -g root -m 755 /etc/apt/keyrings
  sudo test ! -L /etc/apt/keyrings/docker.asc \
    || fail "/etc/apt/keyrings/docker.asc must not be a symbolic link"
  sudo test ! -L /etc/apt/sources.list.d/docker.sources \
    || fail "/etc/apt/sources.list.d/docker.sources must not be a symbolic link"
  sudo install -o root -g root -m 644 \
    "$docker_setup_dir/docker.asc" /etc/apt/keyrings/docker.asc
  sudo install -o root -g root -m 644 \
    "$docker_setup_dir/docker.sources" /etc/apt/sources.list.d/docker.sources

  sudo apt-get update
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y \
    containerd.io docker-buildx-plugin docker-ce docker-ce-cli docker-compose-plugin
  sudo systemctl enable --now docker

  cleanup_docker_setup
  docker_setup_dir=
  trap - 0 1 2 15
}

if ! command -v docker >/dev/null 2>&1; then
  install_docker_engine
fi
sudo docker compose version >/dev/null 2>&1 \
  || fail "the Docker Compose plugin is not available to the administrative account"

if ! id github-deploy >/dev/null 2>&1; then
  sudo adduser --disabled-password --gecos '' github-deploy
fi
[ "$(id -u github-deploy)" -ne 0 ] \
  || fail "github-deploy must never resolve to UID 0"

sudo "$REPOSITORY_DIR/scripts/deploy/vps/provision-host.sh" \
  github-deploy \
  ory-runtime-development \
  "$SIGNING_PUBLIC_KEY" \
  "$DEPLOY_SSH_PUBLIC_KEY"

install_if_missing() {
  source_file=$1
  destination_file=$2

  if sudo test -e "$destination_file" || sudo test -L "$destination_file"; then
    sudo test -f "$destination_file" && sudo test ! -L "$destination_file" \
      || fail "$destination_file exists but is not a regular file"
    return
  fi

  sudo install -o root -g root -m 600 "$source_file" "$destination_file"
}

install_if_missing \
  "$REPOSITORY_DIR/scripts/deploy/env/auth-app.env.example" \
  /etc/idnest/auth-app.env
install_if_missing \
  "$REPOSITORY_DIR/scripts/deploy/env/admin-app.env.example" \
  /etc/idnest/admin-app.env
install_if_missing \
  "$REPOSITORY_DIR/scripts/deploy/env/ory.env.example" \
  /etc/idnest/ory.env

sudo systemctl is-active --quiet ory-auth-release-queue.path \
  || fail "the development release queue watcher is not active"
sudo test ! -e /etc/sudoers.d/ory-auth-deploy \
  || fail "the obsolete deployment sudo policy is still present"

echo "Development VPS host bootstrap complete."
echo "Edit the six VPS-owned configuration files under /etc/idnest with your preferred editor."
echo "Then run: $SCRIPT_DIR/bootstrap-development-vps.sh --validate-config"
