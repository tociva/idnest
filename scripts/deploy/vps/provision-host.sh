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

for command in chown cp cut docker getent grep groupadd id install mv openssl rm ssh-keygen stat systemctl; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
DEPLOY_HOME=$(getent passwd "$DEPLOY_USER" | cut -d: -f6)
[ -n "$DEPLOY_HOME" ] && [ -d "$DEPLOY_HOME" ] && [ ! -L "$DEPLOY_HOME" ] || fail "invalid deployment user home"
docker compose version >/dev/null 2>&1 || fail "Docker Compose plugin is unavailable"
openssl pkey -pubin -in "$RELEASE_SIGNING_PUBLIC_KEY" -noout >/dev/null 2>&1 || fail "release signing public key is not a valid PEM public key"
ssh-keygen -l -f "$DEPLOY_SSH_PUBLIC_KEY" >/dev/null 2>&1 || fail "deployment SSH public key is invalid"

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd "$SCRIPT_DIR/../../.." && pwd)
for file in compose.auth.yaml compose.admin.yaml compose.ory.yaml Dockerfile.kratos deploy-ory-app.sh deploy-ory-infra.sh deploy-ory-auth.sh deploy-ory-admin.sh rollback-ory-app.sh rollback-ory-auth.sh rollback-ory-admin.sh validate-app-env.sh activate-host-release.sh process-ory-release-queue.sh submit-ory-release.sh wait-ory-release.sh ory-auth-release-queue.path ory-auth-release-queue.service auth.conf.example admin.conf.example ory.conf.example; do
  [ -f "$SCRIPT_DIR/$file" ] && [ ! -L "$SCRIPT_DIR/$file" ] || fail "invalid provisioning source: $file"
done

TLS_GROUP=idnest-tls
getent group "$TLS_GROUP" >/dev/null 2>&1 || groupadd --system "$TLS_GROUP"
install -d -o root -g root -m 755 /opt/ory-auth /opt/ory-auth/auth /opt/ory-auth/admin /opt/ory-auth/ory /opt/ory-auth/host-releases /opt/ory-auth/ory/kratos-build /opt/ory-auth/ory/kratos-build/config /opt/ory-auth/ory/kratos-build/config/kratos /opt/ory-auth/ory/config-history /etc/idnest
install -d -o root -g "$TLS_GROUP" -m 750 /etc/idnest/tls
install -o root -g root -m 644 "$RELEASE_SIGNING_PUBLIC_KEY" /etc/idnest/host-release-signing-public.pem
install -d -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" -m 700 "$DEPLOY_HOME/.ssh"
install -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" -m 600 "$DEPLOY_SSH_PUBLIC_KEY" "$DEPLOY_HOME/.ssh/authorized_keys"
install -d -o root -g root -m 700 /opt/ory-auth/auth/deployment-history /opt/ory-auth/admin/deployment-history
install -d -o root -g root -m 711 /var/lib/ory-auth /var/lib/ory-auth/queue
install -d -o root -g root -m 700 /var/lib/ory-auth/incoming /var/lib/ory-auth/queue/processing
install -d -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" -m 700 /var/lib/ory-auth/queue/incoming
install -d -o root -g "$DEPLOY_GROUP" -m 750 /var/lib/ory-auth/queue/results /var/log/ory-auth
install -o root -g root -m 644 "$SCRIPT_DIR/compose.auth.yaml" /opt/ory-auth/auth/compose.yaml
install -o root -g root -m 644 "$SCRIPT_DIR/compose.admin.yaml" /opt/ory-auth/admin/compose.yaml
install -o root -g root -m 644 "$SCRIPT_DIR/compose.ory.yaml" /opt/ory-auth/ory/compose.yaml
install -o root -g root -m 644 "$SCRIPT_DIR/Dockerfile.kratos" /opt/ory-auth/ory/kratos-build/Dockerfile
install -o root -g root -m 755 "$REPO_ROOT/scripts/docker/render-kratos-config.sh" /opt/ory-auth/ory/kratos-build/render-kratos-config.sh
install -o root -g root -m 644 "$REPO_ROOT/config/kratos.tpl.yml" /opt/ory-auth/ory/kratos-build/config/kratos.tpl.yml
cp -R "$REPO_ROOT/config/kratos/." /opt/ory-auth/ory/kratos-build/config/kratos/
chown -R root:root /opt/ory-auth/ory/kratos-build/config
install -o root -g root -m 755 "$SCRIPT_DIR/deploy-ory-app.sh" /usr/local/sbin/deploy-ory-app
install -o root -g root -m 755 "$SCRIPT_DIR/deploy-ory-infra.sh" /usr/local/sbin/deploy-ory-infra
install -o root -g root -m 755 "$SCRIPT_DIR/deploy-ory-auth.sh" /usr/local/sbin/deploy-ory-auth
install -o root -g root -m 755 "$SCRIPT_DIR/deploy-ory-admin.sh" /usr/local/sbin/deploy-ory-admin
install -o root -g root -m 755 "$SCRIPT_DIR/rollback-ory-app.sh" /usr/local/sbin/rollback-ory-app
install -o root -g root -m 755 "$SCRIPT_DIR/rollback-ory-auth.sh" /usr/local/sbin/rollback-ory-auth
install -o root -g root -m 755 "$SCRIPT_DIR/rollback-ory-admin.sh" /usr/local/sbin/rollback-ory-admin
install -o root -g root -m 755 "$SCRIPT_DIR/validate-app-env.sh" /usr/local/sbin/validate-ory-app-env
install -o root -g root -m 755 "$SCRIPT_DIR/activate-host-release.sh" /usr/local/sbin/activate-ory-host-release
install -o root -g root -m 755 "$SCRIPT_DIR/process-ory-release-queue.sh" /usr/local/sbin/process-ory-release-queue
install -o root -g root -m 755 "$SCRIPT_DIR/submit-ory-release.sh" /usr/local/bin/submit-ory-release
install -o root -g root -m 755 "$SCRIPT_DIR/wait-ory-release.sh" /usr/local/bin/wait-ory-release
install -o root -g root -m 644 "$SCRIPT_DIR/ory-auth-release-queue.path" /etc/systemd/system/ory-auth-release-queue.path
install -o root -g root -m 644 "$SCRIPT_DIR/ory-auth-release-queue.service" /etc/systemd/system/ory-auth-release-queue.service

[ -e /etc/idnest/auth.conf ] || install -o root -g root -m 600 "$SCRIPT_DIR/auth.conf.example" /etc/idnest/auth.conf
[ -e /etc/idnest/admin.conf ] || install -o root -g root -m 600 "$SCRIPT_DIR/admin.conf.example" /etc/idnest/admin.conf
[ -e /etc/idnest/ory.conf ] || install -o root -g root -m 600 "$SCRIPT_DIR/ory.conf.example" /etc/idnest/ory.conf

if ! docker network inspect "$RUNTIME_NETWORK" >/dev/null 2>&1; then
  docker network create --attachable "$RUNTIME_NETWORK" >/dev/null
fi
[ "$(docker network inspect --format '{{.Attachable}}' "$RUNTIME_NETWORK")" = true ] || fail "runtime network is not attachable"

# Remove the obsolete CI sudo policy if this host was provisioned by an older release.
rm -f -- /etc/sudoers.d/ory-auth-deploy

systemctl daemon-reload
systemctl enable --now ory-auth-release-queue.path
systemctl is-active --quiet ory-auth-release-queue.path || fail "release queue watcher did not start"

echo "One-time privileged host bootstrap complete."
echo "GitHub Actions can now submit deployments as $DEPLOY_USER without sudo."
echo "Review /etc/idnest/*.conf and install VPS-owned app.env, ory.env, and Origin CA files before the first deployment."
echo "Install origin-cert.pem and origin-ca.pem as root-readable files and origin-key.pem as root:$TLS_GROUP mode 640 under /etc/idnest/tls."
