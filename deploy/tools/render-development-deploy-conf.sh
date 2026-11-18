#!/bin/sh
set -eu

fail() {
  echo "Development deployment configuration rendering failed: $*" >&2
  exit 1
}

[ "$#" -eq 1 ] || fail "usage: render-development-deploy-conf.sh OUTPUT_FILE"
output_file=$1
case "$output_file" in
  ""|*/) fail "OUTPUT_FILE must include a filename" ;;
esac
[ ! -L "$output_file" ] || fail "refusing to replace symbolic link: $output_file"
output_directory=${output_file%/*}
[ "$output_directory" != "$output_file" ] || output_directory=.
if [ ! -d "$output_directory" ] || [ -L "$output_directory" ]; then
  fail "output directory must be a regular directory: $output_directory"
fi

for command in chmod grep mktemp mv rm; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

: "${ECR_PUBLIC_REGISTRY:?ECR_PUBLIC_REGISTRY is required}"
: "${AUTH_ECR_REPOSITORY:?AUTH_ECR_REPOSITORY is required}"
: "${ADMIN_ECR_REPOSITORY:?ADMIN_ECR_REPOSITORY is required}"
: "${SKIP_PUBLIC_HEALTH_CHECK:?SKIP_PUBLIC_HEALTH_CHECK is required}"

printf '%s\n' "$ECR_PUBLIC_REGISTRY" \
  | grep -Eq '^public\.ecr\.aws/[a-z0-9][a-z0-9._-]*$' \
  || fail "ECR_PUBLIC_REGISTRY must be a public.ecr.aws registry alias"
for repository in "$AUTH_ECR_REPOSITORY" "$ADMIN_ECR_REPOSITORY"; do
  printf '%s\n' "$repository" | grep -Eq '^[a-z0-9][a-z0-9._/-]*$' \
    || fail "invalid ECR Public repository: $repository"
done
case "$SKIP_PUBLIC_HEALTH_CHECK" in
  true|false) ;;
  *) fail "SKIP_PUBLIC_HEALTH_CHECK must be true or false" ;;
esac

umask 077
candidate=$(mktemp "$output_directory/.deploy.conf.XXXXXX")
cleanup() {
  rm -f -- "$candidate"
}
trap cleanup EXIT HUP INT TERM

{
  printf 'ECR_PUBLIC_REGISTRY=%s\n' "$ECR_PUBLIC_REGISTRY"
  printf 'AUTH_ECR_REPOSITORY=%s\n' "$AUTH_ECR_REPOSITORY"
  printf 'ADMIN_ECR_REPOSITORY=%s\n' "$ADMIN_ECR_REPOSITORY"
  printf 'SKIP_PUBLIC_HEALTH_CHECK=%s\n' "$SKIP_PUBLIC_HEALTH_CHECK"
} >"$candidate"

chmod 600 "$candidate"
mv -- "$candidate" "$output_file"
candidate=
trap - EXIT HUP INT TERM
echo "Rendered validated development deployment configuration."
