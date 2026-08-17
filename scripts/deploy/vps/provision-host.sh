#!/bin/sh
set -eu

fail() {
  echo "Provisioning failed: $*" >&2
  exit 1
}

[ "$#" -eq 4 ] || fail "usage: provision-host.sh DEPLOY_USER RUNTIME_NETWORK RELEASE_SIGNING_PUBLIC_KEY DEPLOY_SSH_PUBLIC_KEY"
DEPLOY_USER=$1
RUNTIME_NETWORK=$2
RELEASE_SIGNING_PUBLIC_KEY=$3
DEPLOY_SSH_PUBLIC_KEY=$4
printf '%s\n' "$DEPLOY_USER" | grep -Eq '^[a-z_][a-z0-9_-]*$' || fail "invalid deployment user"
printf '%s\n' "$RUNTIME_NETWORK" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_.-]*$' || fail "invalid runtime network"
[ "$(id -u)" -eq 0 ] || fail "run provisioning as root"
id "$DEPLOY_USER" >/dev/null 2>&1 || fail "deployment user does not exist"
DEPLOY_GROUP=$(id -gn "$DEPLOY_USER")
[ -f "$RELEASE_SIGNING_PUBLIC_KEY" ] && [ ! -L "$RELEASE_SIGNING_PUBLIC_KEY" ] && [ -s "$RELEASE_SIGNING_PUBLIC_KEY" ] || fail "invalid release signing public key"
[ -f "$DEPLOY_SSH_PUBLIC_KEY" ] && [ ! -L "$DEPLOY_SSH_PUBLIC_KEY" ] && [ -s "$DEPLOY_SSH_PUBLIC_KEY" ] || fail "invalid deployment SSH public key"

for command in chown cp cut docker getent grep groupadd id install openssl ssh-keygen stat systemctl; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
DEPLOY_HOME=$(getent passwd "$DEPLOY_USER" | cut -d: -f6)
[ -n "$DEPLOY_HOME" ] && [ -d "$DEPLOY_HOME" ] && [ ! -L "$DEPLOY_HOME" ] || fail "invalid deployment user home"
docker compose version >/dev/null 2>&1 || fail "Docker Compose plugin is unavailable"
openssl pkey -pubin -in "$RELEASE_SIGNING_PUBLIC_KEY" -noout >/dev/null 2>&1 || fail "release signing public key is not a valid PEM public key"
ssh-keygen -l -f "$DEPLOY_SSH_PUBLIC_KEY" >/dev/null 2>&1 || fail "deployment SSH public key is invalid"

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd "$SCRIPT_DIR/../../.." && pwd)
for file in compose.auth.yaml compose.admin.yaml compose.idnest.yaml Dockerfile.kratos deploy-idnest-app.sh deploy-idnest-infra.sh deploy-idnest-auth.sh deploy-idnest-admin.sh rollback-idnest-app.sh rollback-idnest-auth.sh rollback-idnest-admin.sh validate-app-env.sh activate-host-release.sh process-idnest-release-queue.sh submit-idnest-release.sh wait-idnest-release.sh idnest-release-queue.path idnest-release-queue.service auth.conf.example admin.conf.example idnest.conf.example; do
  [ -f "$SCRIPT_DIR/$file" ] && [ ! -L "$SCRIPT_DIR/$file" ] || fail "invalid provisioning source: $file"
done

TLS_GROUP=idnest-tls
getent group "$TLS_GROUP" >/dev/null 2>&1 || groupadd --system "$TLS_GROUP"
install -d -o root -g root -m 755 /opt/idnest /opt/idnest/auth /opt/idnest/admin /opt/idnest/identity /opt/idnest/host-releases /opt/idnest/identity/kratos-build /opt/idnest/identity/kratos-build/config /opt/idnest/identity/kratos-build/config/kratos /opt/idnest/identity/config-history /etc/idnest
install -d -o root -g "$TLS_GROUP" -m 750 /etc/idnest/tls
install -o root -g root -m 644 "$RELEASE_SIGNING_PUBLIC_KEY" /etc/idnest/host-release-signing-public.pem
install -d -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" -m 700 "$DEPLOY_HOME/.ssh"
install -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" -m 600 "$DEPLOY_SSH_PUBLIC_KEY" "$DEPLOY_HOME/.ssh/authorized_keys"
install -d -o root -g root -m 700 /opt/idnest/auth/deployment-history /opt/idnest/admin/deployment-history
install -d -o root -g root -m 711 /var/lib/idnest /var/lib/idnest/queue
install -d -o root -g root -m 700 /var/lib/idnest/incoming /var/lib/idnest/queue/processing
install -d -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" -m 700 /var/lib/idnest/queue/incoming
install -d -o root -g "$DEPLOY_GROUP" -m 750 /var/lib/idnest/queue/results /var/log/idnest
install -o root -g root -m 644 "$SCRIPT_DIR/compose.auth.yaml" /opt/idnest/auth/compose.yaml
install -o root -g root -m 644 "$SCRIPT_DIR/compose.admin.yaml" /opt/idnest/admin/compose.yaml
install -o root -g root -m 644 "$SCRIPT_DIR/compose.idnest.yaml" /opt/idnest/identity/compose.yaml
install -o root -g root -m 644 "$SCRIPT_DIR/Dockerfile.kratos" /opt/idnest/identity/kratos-build/Dockerfile
install -o root -g root -m 755 "$REPO_ROOT/scripts/docker/render-kratos-config.sh" /opt/idnest/identity/kratos-build/render-kratos-config.sh
install -o root -g root -m 644 "$REPO_ROOT/config/kratos.tpl.yml" /opt/idnest/identity/kratos-build/config/kratos.tpl.yml
cp -R "$REPO_ROOT/config/kratos/." /opt/idnest/identity/kratos-build/config/kratos/
chown -R root:root /opt/idnest/identity/kratos-build/config
install -o root -g root -m 755 "$SCRIPT_DIR/deploy-idnest-app.sh" /usr/local/sbin/deploy-idnest-app
install -o root -g root -m 755 "$SCRIPT_DIR/deploy-idnest-infra.sh" /usr/local/sbin/deploy-idnest-infra
install -o root -g root -m 755 "$SCRIPT_DIR/deploy-idnest-auth.sh" /usr/local/sbin/deploy-idnest-auth
install -o root -g root -m 755 "$SCRIPT_DIR/deploy-idnest-admin.sh" /usr/local/sbin/deploy-idnest-admin
install -o root -g root -m 755 "$SCRIPT_DIR/rollback-idnest-app.sh" /usr/local/sbin/rollback-idnest-app
install -o root -g root -m 755 "$SCRIPT_DIR/rollback-idnest-auth.sh" /usr/local/sbin/rollback-idnest-auth
install -o root -g root -m 755 "$SCRIPT_DIR/rollback-idnest-admin.sh" /usr/local/sbin/rollback-idnest-admin
install -o root -g root -m 755 "$SCRIPT_DIR/validate-app-env.sh" /usr/local/sbin/validate-idnest-app-env
install -o root -g root -m 755 "$SCRIPT_DIR/activate-host-release.sh" /usr/local/sbin/activate-idnest-host-release
install -o root -g root -m 755 "$SCRIPT_DIR/process-idnest-release-queue.sh" /usr/local/sbin/process-idnest-release-queue
install -o root -g root -m 755 "$SCRIPT_DIR/submit-idnest-release.sh" /usr/local/bin/submit-idnest-release
install -o root -g root -m 755 "$SCRIPT_DIR/wait-idnest-release.sh" /usr/local/bin/wait-idnest-release
install -o root -g root -m 644 "$SCRIPT_DIR/idnest-release-queue.path" /etc/systemd/system/idnest-release-queue.path
install -o root -g root -m 644 "$SCRIPT_DIR/idnest-release-queue.service" /etc/systemd/system/idnest-release-queue.service

[ -e /etc/idnest/auth.conf ] || install -o root -g root -m 600 "$SCRIPT_DIR/auth.conf.example" /etc/idnest/auth.conf
[ -e /etc/idnest/admin.conf ] || install -o root -g root -m 600 "$SCRIPT_DIR/admin.conf.example" /etc/idnest/admin.conf
[ -e /etc/idnest/idnest.conf ] || install -o root -g root -m 600 "$SCRIPT_DIR/idnest.conf.example" /etc/idnest/idnest.conf

if ! docker network inspect "$RUNTIME_NETWORK" >/dev/null 2>&1; then
  docker network create --attachable "$RUNTIME_NETWORK" >/dev/null
fi
[ "$(docker network inspect --format '{{.Attachable}}' "$RUNTIME_NETWORK")" = true ] || fail "runtime network is not attachable"

systemctl daemon-reload
systemctl enable --now idnest-release-queue.path
systemctl is-active --quiet idnest-release-queue.path || fail "release queue watcher did not start"

echo "One-time privileged host bootstrap complete."
echo "GitHub Actions can now submit deployments as $DEPLOY_USER without sudo."
echo "Review /etc/idnest/*.conf and install VPS-owned app.env, idnest.env, and Origin CA files before the first deployment."
echo "Install origin-cert.pem and origin-ca.pem as root-readable files and origin-key.pem as root:$TLS_GROUP mode 640 under /etc/idnest/tls."
