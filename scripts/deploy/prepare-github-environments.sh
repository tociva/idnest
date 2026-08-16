#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "Usage: $0 DEV_SSH_PRIVATE_KEY DEV_KNOWN_HOSTS DEV_RELEASE_SIGNING_KEY OUTPUT_DIR" >&2
  exit 2
fi

DEV_SSH_PRIVATE_KEY="$1"
DEV_KNOWN_HOSTS="$2"
DEV_RELEASE_SIGNING_PRIVATE_KEY="$3"
OUTPUT_DIR="$4"

for file in "$DEV_SSH_PRIVATE_KEY" "$DEV_KNOWN_HOSTS" "$DEV_RELEASE_SIGNING_PRIVATE_KEY"; do
  [ -f "$file" ] && [ ! -L "$file" ] && [ -s "$file" ] || {
    echo "Expected a non-empty regular file: $file" >&2
    exit 1
  }
done
for command in base64 install mktemp mv openssl ssh-keygen tr; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Missing required command: $command" >&2
    exit 1
  }
done
openssl pkey -in "$DEV_RELEASE_SIGNING_PRIVATE_KEY" -noout >/dev/null 2>&1 || {
  echo "Invalid host release signing private key: $DEV_RELEASE_SIGNING_PRIVATE_KEY" >&2
  exit 1
}
ssh-keygen -y -f "$DEV_SSH_PRIVATE_KEY" >/dev/null 2>&1 || {
  echo "Invalid or encrypted deployment SSH private key: $DEV_SSH_PRIVATE_KEY" >&2
  exit 1
}
ssh-keygen -l -f "$DEV_KNOWN_HOSTS" >/dev/null 2>&1 || {
  echo "Invalid SSH known-hosts file: $DEV_KNOWN_HOSTS" >&2
  exit 1
}
if [ -e "$OUTPUT_DIR" ]; then
  [ -d "$OUTPUT_DIR" ] && [ ! -L "$OUTPUT_DIR" ] || {
    echo "Output directory must not be a symbolic link: $OUTPUT_DIR" >&2
    exit 1
  }
else
  install -d -m 700 "$OUTPUT_DIR"
fi
chmod 700 "$OUTPUT_DIR"
write_secrets() {
  destination=$1
  ssh_private_key=$2
  known_hosts=$3
  signing_key=$4
  [ ! -L "$destination" ] || {
    echo "Refusing to replace symbolic link: $destination" >&2
    exit 1
  }
  umask 077
  temporary=$(mktemp "$OUTPUT_DIR/.secrets.env.XXXXXX")
  {
    printf 'VPS_SSH_PRIVATE_KEY_B64='; base64 <"$ssh_private_key" | tr -d '\n'; echo
    printf 'VPS_SSH_KNOWN_HOSTS_B64='; base64 <"$known_hosts" | tr -d '\n'; echo
    printf 'HOST_RELEASE_SIGNING_PRIVATE_KEY_B64='; base64 <"$signing_key" | tr -d '\n'; echo
  } >"$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$destination"
}

write_secrets "$OUTPUT_DIR/development-auth.secrets.env" "$DEV_SSH_PRIVATE_KEY" "$DEV_KNOWN_HOSTS" "$DEV_RELEASE_SIGNING_PRIVATE_KEY"
write_secrets "$OUTPUT_DIR/development-admin.secrets.env" "$DEV_SSH_PRIVATE_KEY" "$DEV_KNOWN_HOSTS" "$DEV_RELEASE_SIGNING_PRIVATE_KEY"
echo "Prepared development GitHub secret dotenv files in $OUTPUT_DIR. Values were not printed."
