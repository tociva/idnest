#!/bin/sh
set -eu

readonly RELEASE_ROOT=/opt/idnest/host-releases
readonly CURRENT_RELEASE=/opt/idnest/host-release.env
readonly SIGNING_PUBLIC_KEY=/etc/idnest/host-release-signing-public.pem

fail() {
  echo "Host release activation failed: $*" >&2
  exit 1
}

[ "$#" -eq 5 ] || fail "usage: activate-host-release.sh ARCHIVE SIGNATURE SHA256 GIT_REVISION REQUEST_ID"
ARCHIVE=$1
SIGNATURE=$2
EXPECTED_SHA256=$3
REVISION=$4
REQUEST_ID=$5
[ "$(id -u)" -eq 0 ] || fail "host release activation must run as root"
printf '%s\n' "$EXPECTED_SHA256" | grep -Eq '^[a-f0-9]{64}$' || fail "invalid expected checksum"
printf '%s\n' "$REVISION" | grep -Eq '^[a-f0-9]{40}$' || fail "invalid Git revision"
printf '%s\n' "$REQUEST_ID" | grep -Eq '^[1-9][0-9]*-[1-9][0-9]*$' || fail "invalid request ID"
[ -f "$ARCHIVE" ] && [ ! -L "$ARCHIVE" ] && [ -s "$ARCHIVE" ] || fail "invalid host release archive"
[ -f "$SIGNATURE" ] && [ ! -L "$SIGNATURE" ] && [ -s "$SIGNATURE" ] || fail "invalid host release signature"
[ -f "$SIGNING_PUBLIC_KEY" ] && [ ! -L "$SIGNING_PUBLIC_KEY" ] || fail "host release signing public key is unavailable"
[ "$(stat -c '%U' "$SIGNING_PUBLIC_KEY")" = root ] || fail "host release signing public key must be root-owned"

for command in awk cp grep id install mv openssl rm sha256sum stat systemctl tar; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

ACTUAL_SHA256=$(sha256sum "$ARCHIVE" | awk '{print $1}')
[ "$ACTUAL_SHA256" = "$EXPECTED_SHA256" ] || fail "host release checksum mismatch"
openssl pkeyutl -verify -rawin -pubin -inkey "$SIGNING_PUBLIC_KEY" \
  -sigfile "$SIGNATURE" -in "$ARCHIVE" >/dev/null 2>&1 \
  || fail "host release signature verification failed"

REQUIRED_FILES='scripts/deploy/vps/compose.auth.yaml
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
scripts/deploy/vps/idnest-cloudflared.service
scripts/docker/render-kratos-config.sh'

entries=$(tar -tzf "$ARCHIVE") || fail "cannot list host release archive"
[ -n "$entries" ] || fail "host release archive is empty"
[ "$(printf '%s\n' "$entries" | wc -l | tr -d ' ')" -eq 14 ] || fail "host release archive must contain exactly 14 files"
printf '%s\n' "$entries" | while IFS= read -r entry; do
  printf '%s\n' "$REQUIRED_FILES" | grep -Fx "$entry" >/dev/null || fail "unexpected archive entry: $entry"
done
printf '%s\n' "$REQUIRED_FILES" | while IFS= read -r required; do
  [ "$(printf '%s\n' "$entries" | grep -Fxc "$required")" -eq 1 ] || fail "missing or duplicate archive entry: $required"
done
tar -tvzf "$ARCHIVE" | awk '$1 !~ /^-/ { exit 1 }' || fail "host release archive may contain only regular files"

install -d -o root -g root -m 755 "$RELEASE_ROOT"
RELEASE_DIR="$RELEASE_ROOT/$REVISION-$REQUEST_ID"
[ ! -e "$RELEASE_DIR" ] || fail "host release directory already exists"
install -d -o root -g root -m 700 "$RELEASE_DIR"
tar -xzf "$ARCHIVE" --directory "$RELEASE_DIR" --no-same-owner --no-same-permissions
chown -R root:root "$RELEASE_DIR"

for script in "$RELEASE_DIR"/scripts/deploy/vps/*.sh "$RELEASE_DIR/scripts/docker/render-kratos-config.sh"; do
  sh -n "$script" || fail "invalid shell syntax: $script"
done

BACKUP_ROOT="$RELEASE_DIR/previous"
MANIFEST="$RELEASE_DIR/installed-files.manifest"
install -d -o root -g root -m 700 "$BACKUP_ROOT"
: >"$MANIFEST"
chmod 600 "$MANIFEST"

install_one() {
  source_file=$1
  target_file=$2
  mode=$3
  key=$4
  [ -f "$source_file" ] && [ ! -L "$source_file" ] || fail "invalid release source: $source_file"
  [ ! -L "$target_file" ] || fail "refusing to replace symbolic link: $target_file"
  if [ -e "$target_file" ]; then
    [ -f "$target_file" ] || fail "target is not a regular file: $target_file"
    cp -p -- "$target_file" "$BACKUP_ROOT/$key"
    printf 'present|%s|%s\n' "$key" "$target_file" >>"$MANIFEST"
  else
    printf 'absent|%s|%s\n' "$key" "$target_file" >>"$MANIFEST"
  fi
  candidate="$target_file.candidate.$REQUEST_ID"
  install -o root -g root -m "$mode" "$source_file" "$candidate"
  mv -- "$candidate" "$target_file"
}

restore_previous() {
  while IFS='|' read -r state key target_file; do
    case "$state" in
      present) install -o root -g root -m "$(stat -c '%a' "$BACKUP_ROOT/$key")" "$BACKUP_ROOT/$key" "$target_file" ;;
      absent) rm -f -- "$target_file" ;;
    esac
  done <"$MANIFEST"
  systemctl daemon-reload
}

ACTIVATED=false
activation_cleanup() {
  exit_code=$?
  if [ "$ACTIVATED" != true ]; then
    restore_previous
  fi
  return "$exit_code"
}
trap activation_cleanup EXIT
trap 'exit 1' HUP INT TERM

install_one "$RELEASE_DIR/scripts/deploy/vps/compose.auth.yaml" /opt/idnest/auth/compose.yaml 644 compose-auth
install_one "$RELEASE_DIR/scripts/deploy/vps/compose.admin.yaml" /opt/idnest/admin/compose.yaml 644 compose-admin
install_one "$RELEASE_DIR/scripts/deploy/vps/compose.idnest.yaml" /opt/idnest/identity/compose.yaml 644 compose-idnest
install_one "$RELEASE_DIR/scripts/deploy/vps/Dockerfile.kratos" /opt/idnest/identity/kratos-build/Dockerfile 644 dockerfile-kratos
install_one "$RELEASE_DIR/scripts/docker/render-kratos-config.sh" /opt/idnest/identity/kratos-build/render-kratos-config.sh 755 render-kratos-config
install_one "$RELEASE_DIR/scripts/deploy/vps/deploy-idnest-app.sh" /usr/local/sbin/deploy-idnest-app 755 deploy-idnest-app
install_one "$RELEASE_DIR/scripts/deploy/vps/deploy-idnest-infra.sh" /usr/local/sbin/deploy-idnest-infra 755 deploy-idnest-infra
install_one "$RELEASE_DIR/scripts/deploy/vps/deploy-idnest-auth.sh" /usr/local/sbin/deploy-idnest-auth 755 deploy-idnest-auth
install_one "$RELEASE_DIR/scripts/deploy/vps/deploy-idnest-admin.sh" /usr/local/sbin/deploy-idnest-admin 755 deploy-idnest-admin
install_one "$RELEASE_DIR/scripts/deploy/vps/rollback-idnest-app.sh" /usr/local/sbin/rollback-idnest-app 755 rollback-idnest-app
install_one "$RELEASE_DIR/scripts/deploy/vps/rollback-idnest-auth.sh" /usr/local/sbin/rollback-idnest-auth 755 rollback-idnest-auth
install_one "$RELEASE_DIR/scripts/deploy/vps/rollback-idnest-admin.sh" /usr/local/sbin/rollback-idnest-admin 755 rollback-idnest-admin
install_one "$RELEASE_DIR/scripts/deploy/vps/validate-app-env.sh" /usr/local/sbin/validate-idnest-app-env 755 validate-app-env
install_one "$RELEASE_DIR/scripts/deploy/vps/idnest-cloudflared.service" /etc/systemd/system/idnest-cloudflared.service 644 idnest-cloudflared-service
systemctl daemon-reload
systemctl try-restart idnest-cloudflared.service
systemctl is-active --quiet idnest-cloudflared.service \
  || fail "Cloudflare Tunnel connector is not active after host release activation"

umask 077
{
  printf 'GIT_REVISION=%s\n' "$REVISION"
  printf 'REQUEST_ID=%s\n' "$REQUEST_ID"
  printf 'HOST_BUNDLE_SHA256=%s\n' "$EXPECTED_SHA256"
  printf 'RELEASE_DIRECTORY=%s\n' "$RELEASE_DIR"
} >"$CURRENT_RELEASE.tmp"
mv -- "$CURRENT_RELEASE.tmp" "$CURRENT_RELEASE"
ACTIVATED=true
echo "Activated host deployment assets from revision $REVISION."
