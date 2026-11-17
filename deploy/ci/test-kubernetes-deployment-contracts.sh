#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Kubernetes deployment contract failed: $*" >&2
  exit 1
}

SCRIPT_DIR=$(CDPATH= cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(CDPATH= cd "$SCRIPT_DIR/../.." && pwd)
CHART=$REPO_ROOT/deploy/charts/idnest-app
digest=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
temporary=$(mktemp -d "${TMPDIR:-/tmp}/idnest-kubernetes-contract.XXXXXX")
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT HUP INT TERM

for command in grep helm; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

for environment in development production; do
  for component in auth admin; do
    values=$REPO_ROOT/deploy/environments/$environment/$component.values.yaml
    rendered=$temporary/$environment-$component.yaml
    [ -f "$values" ] || fail "missing values file: $values"
    helm lint "$CHART" --values "$values" \
      --set-string image.repository=example.invalid/idnest/$component \
      --set-string image.digest=$digest >/dev/null
    helm template "idnest-$component" "$CHART" \
      --namespace "idnest-$environment" \
      --values "$values" \
      --set-string image.repository=example.invalid/idnest/$component \
      --set-string image.digest=$digest >"$rendered"

    grep -Fq "image: \"example.invalid/idnest/$component@$digest\"" "$rendered" \
      || fail "$component image is not digest pinned"
    grep -Fq 'type: ClusterIP' "$rendered" || fail "$component Service is not private"
    grep -Fq 'automountServiceAccountToken: false' "$rendered" \
      || fail "$component automounts a service-account token"
    grep -Fq 'readOnlyRootFilesystem: true' "$rendered" \
      || fail "$component root filesystem is writable"
    grep -Fq 'allowPrivilegeEscalation: false' "$rendered" \
      || fail "$component permits privilege escalation"
    grep -Fq 'helm.sh/hook: pre-install,pre-upgrade' "$rendered" \
      || fail "$component migration is not a blocking pre-deployment hook"
    grep -Fq "name: idnest-$component-secrets" "$rendered" \
      || fail "$component does not reference its runtime Secret"

    if [ "$component" = admin ]; then
      grep -Fq 'helm.sh/hook: post-install,post-upgrade' "$rendered" \
        || fail "admin client provisioning hook is missing"
      grep -Fq 'scripts/setup/provision-admin-client.js' "$rendered" \
        || fail "admin client provisioner is missing"
    elif grep -Fq 'scripts/setup/provision-admin-client.js' "$rendered"; then
      fail "auth release contains the admin client provisioner"
    fi

    if grep -Eq 'type: (LoadBalancer|NodePort)|kind: Ingress|kind: HTTPRoute' "$rendered"; then
      fail "$component chart exposes a public Kubernetes endpoint"
    fi
  done
done

echo "Kubernetes deployment contracts passed."

