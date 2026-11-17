#!/bin/sh
set -eu

fail() {
  echo "Apple private-key validation failed: $*" >&2
  exit 1
}

[ "$#" -eq 1 ] || fail "usage: validate-apple-private-key.sh PRIVATE_KEY_FILE"
private_key_file=$1

[ -f "$private_key_file" ] && [ ! -L "$private_key_file" ] && [ -s "$private_key_file" ] \
  || fail "private key must be a non-empty regular file"

for command in grep openssl sed tail; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

[ "$(sed -n '1p' "$private_key_file")" = '-----BEGIN PRIVATE KEY-----' ] \
  || fail "key must use PKCS#8 PEM encoding"
[ "$(tail -n 1 "$private_key_file")" = '-----END PRIVATE KEY-----' ] \
  || fail "key must end with a PKCS#8 PEM footer"

openssl pkey -in "$private_key_file" -check -noout >/dev/null 2>&1 \
  || fail "key is not a valid private key"
key_description=$(openssl pkey -in "$private_key_file" -text_pub -noout 2>/dev/null) \
  || fail "key public parameters could not be inspected"
printf '%s\n' "$key_description" | grep -Eq 'ASN1 OID: prime256v1|NIST CURVE: P-256' \
  || fail "key must be an EC private key on the P-256 curve"

echo "Apple private key is valid."
