#!/bin/sh
set -eu

fail() {
  echo "Development VPS bootstrap failed: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: bootstrap-development-vps.sh

Run as a non-root administrative account with sudo access from the transferred
~/idnest-bootstrap directory. The script verifies the complete payload,
installs Docker, provisions the signed release queue, and validates the fresh
host.
EOF
}

case "${1:-}" in
  "") ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
[ "$#" -eq 0 ] || { usage >&2; exit 2; }

[ "$(id -u)" -ne 0 ] \
  || fail "do not run this script as root; use a non-root account with sudo access"
[ "$(id -un)" != idnest-deploy ] \
  || fail "idnest-deploy is deployment-only; use a separate non-root administrative account"

for command in awk dirname grep id sha256sum sudo tar tr wc; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

SCRIPT_DIR=$(CDPATH='' cd "$(dirname "$0")" && pwd)
ARCHIVE_NAME=idnest-development-vps-bootstrap.tar.gz
CHECKSUM_NAME=$ARCHIVE_NAME.sha256
ARCHIVE_PATH=$SCRIPT_DIR/$ARCHIVE_NAME
CHECKSUM_PATH=$SCRIPT_DIR/$CHECKSUM_NAME
SIGNING_PUBLIC_KEY=$SCRIPT_DIR/host-release-signing-public.pem
DEPLOY_SSH_PUBLIC_KEY=$SCRIPT_DIR/idnest-deploy-ed25519.pub
REPOSITORY_DIR=$SCRIPT_DIR/repository
SCRIPT_PATH=$SCRIPT_DIR/bootstrap-development-vps.sh
RUNTIME_NETWORK=idnest-runtime-development
RUNTIME_SUBNET=172.23.0.0/16

if ! {
  [ -f "$SCRIPT_PATH" ] &&
    [ ! -L "$SCRIPT_PATH" ]
}; then
  fail "the bootstrap script must be a regular file, not a symbolic link"
fi
for required_file in \
  "$ARCHIVE_PATH" \
  "$CHECKSUM_PATH" \
  "$SIGNING_PUBLIC_KEY" \
  "$DEPLOY_SSH_PUBLIC_KEY"; do
  if ! {
    [ -f "$required_file" ] &&
      [ ! -L "$required_file" ] &&
      [ -s "$required_file" ]
  }; then
    fail "missing or invalid transferred file: $required_file"
  fi
done

cd "$SCRIPT_DIR"
sha256sum --check "$CHECKSUM_NAME" \
  || fail "transferred bootstrap checksum verification failed"

required_members='scripts/deploy/vps/provision-host.sh
scripts/deploy/vps/compose.auth.yaml
scripts/deploy/vps/compose.admin.yaml
scripts/deploy/vps/compose.idnest.yaml
scripts/deploy/vps/Dockerfile.kratos
scripts/deploy/vps/deploy-idnest-app.sh
scripts/deploy/vps/deploy-idnest-infra.sh
scripts/deploy/vps/deploy-idnest-auth.sh
scripts/deploy/vps/deploy-idnest-admin.sh
scripts/deploy/vps/rollback-idnest-app.sh
scripts/deploy/vps/rollback-idnest-auth.sh
scripts/deploy/vps/rollback-idnest-admin.sh
scripts/deploy/vps/validate-app-env.sh
scripts/deploy/vps/activate-host-release.sh
scripts/deploy/vps/process-idnest-release-queue.sh
scripts/deploy/vps/submit-idnest-release.sh
scripts/deploy/vps/wait-idnest-release.sh
scripts/deploy/vps/idnest-release-queue.path
scripts/deploy/vps/idnest-release-queue.service
scripts/deploy/vps/validate-development-host.sh
scripts/deploy/vps/auth.conf.example
scripts/deploy/vps/admin.conf.example
scripts/deploy/vps/idnest.conf.example
scripts/docker/render-kratos-config.sh
config/kratos.tpl.yml
config/kratos/identity.schema.json
config/kratos/oidc.apple.mapper.jsonnet
config/kratos/oidc.google.mapper.jsonnet'
members=$(tar -tzf "$ARCHIVE_PATH") || fail "cannot list bootstrap archive"
[ "$(printf '%s\n' "$members" | wc -l | tr -d ' ')" -eq 28 ] \
  || fail "bootstrap archive must contain exactly 28 files"
printf '%s\n' "$members" | while IFS= read -r member; do
  printf '%s\n' "$required_members" | grep -Fx "$member" >/dev/null \
    || fail "unexpected bootstrap archive member: $member"
done
printf '%s\n' "$required_members" | while IFS= read -r required; do
  [ "$(printf '%s\n' "$members" | grep -Fxc "$required")" -eq 1 ] \
    || fail "missing or duplicate bootstrap archive member: $required"
done
tar -tvzf "$ARCHIVE_PATH" | awk '$1 !~ /^-/ {exit 1}' \
  || fail "bootstrap archive may contain only regular files"

sudo -v

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
if ! {
  [ -f "$extraction_dir/scripts/deploy/vps/provision-host.sh" ] &&
    [ ! -L "$extraction_dir/scripts/deploy/vps/provision-host.sh" ]
}; then
  fail "the extracted payload does not contain a valid host provisioner"
fi

if [ -e "$REPOSITORY_DIR" ] || [ -L "$REPOSITORY_DIR" ]; then
  if ! {
    [ -d "$REPOSITORY_DIR" ] &&
      [ ! -L "$REPOSITORY_DIR" ]
  }; then
    fail "$REPOSITORY_DIR exists but is not a regular directory"
  fi
  [ "$(stat -c '%u' "$REPOSITORY_DIR")" -eq "$(id -u)" ] \
    || fail "$REPOSITORY_DIR is not owned by the current account"
  rm -rf -- "$REPOSITORY_DIR"
fi
mv "$extraction_dir" "$REPOSITORY_DIR"
extraction_dir=
trap - 0 1 2 15

sudo apt-get update
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y \
  adduser ca-certificates coreutils curl grep iproute2 openssl tar util-linux

for command in cat curl docker grep systemctl; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command after package installation: $command"
done

install_docker_engine() {
  [ -r /etc/os-release ] || fail "cannot detect the VPS operating system"
  # /etc/os-release is a root-owned operating-system interface on the VPS.
  # shellcheck source=/dev/null
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

if ! id idnest-deploy >/dev/null 2>&1; then
  sudo adduser --disabled-password --gecos '' idnest-deploy
fi
[ "$(id -u idnest-deploy)" -ne 0 ] \
  || fail "idnest-deploy must never resolve to UID 0"

sudo "$REPOSITORY_DIR/scripts/deploy/vps/provision-host.sh" \
  idnest-deploy \
  "$RUNTIME_NETWORK" \
  "$RUNTIME_SUBNET" \
  "$SIGNING_PUBLIC_KEY" \
  "$DEPLOY_SSH_PUBLIC_KEY"

sudo systemctl is-active --quiet idnest-release-queue.path \
  || fail "the development release queue watcher is not active"
sudo /usr/local/sbin/validate-idnest-development-host

echo "Development VPS host bootstrap complete."
echo "Docker runtime network $RUNTIME_NETWORK uses pinned subnet $RUNTIME_SUBNET."
echo "Review the three VPS-owned *.conf files under /etc/idnest."
echo "Signed GitHub deployments install idnest.env, auth-app.env, and admin-app.env."
echo "Configure the four public hostname routes before deploying."
