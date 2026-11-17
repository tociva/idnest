#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Idnest host bootstrap failed: $*" >&2
  exit 1
}

[[ ${EUID} -eq 0 ]] || fail "run this script as root (for example, sudo $0)"

SCRIPT_DIR=$(CDPATH= cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=${1:-$(CDPATH= cd "$SCRIPT_DIR/../.." && pwd)}
APP_ROOT=/opt/idnest
CONFIG_ROOT=/etc/idnest
STATE_ROOT=/var/lib/idnest

for command in chmod chown cp docker find install mkdir; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
docker compose version >/dev/null 2>&1 || fail "Docker Compose plugin is required"

required_files=(
  "$REPO_ROOT/deploy/vps/compose.auth.yaml"
  "$REPO_ROOT/deploy/vps/compose.admin.yaml"
  "$REPO_ROOT/deploy/vps/compose.idnest.yaml"
  "$REPO_ROOT/deploy/vps/deploy-idnest-version.sh"
  "$REPO_ROOT/deploy/vps/validate-app-env.sh"
  "$REPO_ROOT/deploy/vps/deploy.conf.example"
  "$REPO_ROOT/deploy/vps/auth.conf.example"
  "$REPO_ROOT/deploy/vps/admin.conf.example"
  "$REPO_ROOT/deploy/vps/idnest.conf.example"
  "$REPO_ROOT/deploy/images/Dockerfile.kratos"
  "$REPO_ROOT/deploy/images/render-kratos-config.sh"
  "$REPO_ROOT/config/kratos.tpl.yml"
  "$REPO_ROOT/config/kratos/identity.schema.json"
)
for file in "${required_files[@]}"; do
  [[ -f "$file" && ! -L "$file" ]] || fail "required regular file is missing: $file"
done

install -d -o root -g root -m 755 \
  "$APP_ROOT/auth" "$APP_ROOT/admin" "$APP_ROOT/identity/kratos-build/config/kratos" \
  "$STATE_ROOT/releases"
install -d -o root -g root -m 700 "$CONFIG_ROOT"

install -o root -g root -m 644 "$REPO_ROOT/deploy/vps/compose.auth.yaml" "$APP_ROOT/auth/compose.yaml"
install -o root -g root -m 644 "$REPO_ROOT/deploy/vps/compose.admin.yaml" "$APP_ROOT/admin/compose.yaml"
install -o root -g root -m 644 "$REPO_ROOT/deploy/vps/compose.idnest.yaml" "$APP_ROOT/identity/compose.yaml"
install -o root -g root -m 644 "$REPO_ROOT/deploy/images/Dockerfile.kratos" "$APP_ROOT/identity/kratos-build/Dockerfile"
install -o root -g root -m 755 "$REPO_ROOT/deploy/images/render-kratos-config.sh" \
  "$APP_ROOT/identity/kratos-build/render-kratos-config.sh"
install -o root -g root -m 644 "$REPO_ROOT/config/kratos.tpl.yml" \
  "$APP_ROOT/identity/kratos-build/config/kratos.tpl.yml"
find "$APP_ROOT/identity/kratos-build/config/kratos" -mindepth 1 -delete
cp -R "$REPO_ROOT/config/kratos/." "$APP_ROOT/identity/kratos-build/config/kratos/"
find "$APP_ROOT/identity/kratos-build/config/kratos" -type d -exec chmod 755 {} +
find "$APP_ROOT/identity/kratos-build/config/kratos" -type f -exec chmod 644 {} +
chown -R root:root "$APP_ROOT/identity/kratos-build/config"

install -o root -g root -m 755 "$REPO_ROOT/deploy/vps/deploy-idnest-version.sh" /usr/local/sbin/deploy-idnest-version
install -o root -g root -m 755 "$REPO_ROOT/deploy/vps/validate-app-env.sh" /usr/local/sbin/validate-idnest-app-env

install_default() {
  local source=$1 destination=$2
  if [[ ! -e "$destination" ]]; then
    install -o root -g root -m 600 "$source" "$destination"
    echo "Created configuration template: $destination"
  fi
}

install_default "$REPO_ROOT/deploy/vps/deploy.conf.example" "$CONFIG_ROOT/deploy.conf"
install_default "$REPO_ROOT/deploy/vps/auth.conf.example" "$CONFIG_ROOT/auth.conf"
install_default "$REPO_ROOT/deploy/vps/admin.conf.example" "$CONFIG_ROOT/admin.conf"
install_default "$REPO_ROOT/deploy/vps/idnest.conf.example" "$CONFIG_ROOT/idnest.conf"

# shellcheck source=/dev/null
source "$CONFIG_ROOT/idnest.conf"
: "${IDNEST_RUNTIME_NETWORK:?IDNEST_RUNTIME_NETWORK is required in $CONFIG_ROOT/idnest.conf}"
if ! docker network inspect "$IDNEST_RUNTIME_NETWORK" >/dev/null 2>&1; then
  docker network create "$IDNEST_RUNTIME_NETWORK" >/dev/null
  echo "Created Docker network: $IDNEST_RUNTIME_NETWORK"
fi

echo "Idnest host files are installed."
echo "Before the first deployment:"
echo "  1. Set the ECR Public alias in $CONFIG_ROOT/deploy.conf."
echo "  2. Review $CONFIG_ROOT/auth.conf, admin.conf, and idnest.conf."
echo "  3. Install root-owned mode-0600 idnest.env, auth-app.env, and admin-app.env in $CONFIG_ROOT."
echo "  4. Run: sudo deploy-idnest-version VERSION all"
