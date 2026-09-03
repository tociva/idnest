#!/bin/sh
set -eu

fail() {
  echo "Development host validation failed: $*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail "must run as root"
for command in awk docker grep id ss stat systemctl; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

for unit in docker.service idnest-release-queue.path; do
  systemctl is-enabled --quiet "$unit" || fail "$unit is not enabled"
  systemctl is-active --quiet "$unit" || fail "$unit is not active"
done

for file in \
  /etc/idnest/auth.conf \
  /etc/idnest/admin.conf \
  /etc/idnest/idnest.conf \
  /etc/idnest/host-release-signing-public.pem; do
  if [ ! -f "$file" ] || [ -L "$file" ] || [ "$(stat -c '%U' "$file")" != root ]; then
    fail "invalid root-owned file: $file"
  fi
done

RUNTIME_NETWORK=idnest-runtime-development
RUNTIME_SUBNET=172.23.0.0/16
actual_subnet=$(docker network inspect \
  --format '{{range .IPAM.Config}}{{println .Subnet}}{{end}}' \
  "$RUNTIME_NETWORK") || fail "the development Docker runtime network is missing"
[ "$actual_subnet" = "$RUNTIME_SUBNET" ] \
  || fail "runtime subnet is $actual_subnet; expected $RUNTIME_SUBNET"
[ "$(docker network inspect --format '{{.Attachable}}' "$RUNTIME_NETWORK")" = true ] \
  || fail "the development Docker runtime network is not attachable"

if ! ss -H -ltn | awk '
  $1 == "LISTEN" {
    address=$4
    port=address
    sub(/^.*:/, "", port)
    if (port ~ /^(4434|4433|4445|4444|8444|8445|8446|8447)$/ \
        && address !~ /^127\.0\.0\.1:/ \
        && address !~ /^\[::1\]:/) {
      print address > "/dev/stderr"
      exit 1
    }
  }
'; then
  fail "an Idnest origin port is listening publicly"
fi

deploy_groups=$(id -nG idnest-deploy)
printf '%s\n' "$deploy_groups" | grep -Eq '(^| )(sudo|docker)( |$)' \
  && fail "idnest-deploy has privileged group membership"

echo "Idnest development host validation passed."
