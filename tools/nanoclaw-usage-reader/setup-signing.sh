#!/bin/sh
# Create a dedicated, local code-signing identity for NanoClaw Usage Reader.
# It is used only to make the helper's macOS privacy identity stable across
# rebuilds. It does not grant any Accessibility, screen, or automation access.
set -eu

IDENTITY="NanoClaw Usage Reader Local Signing"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nanoclaw-usage-signing.XXXXXX")"
trap 'rm -rf "$TEMP_DIR"' EXIT HUP INT TERM

if security find-identity -v -p codesigning | grep -Fq "$IDENTITY"; then
  printf '%s\n' "Signing identity already exists: $IDENTITY"
  exit 0
fi

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -subj "/CN=$IDENTITY" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" \
  -keyout "$TEMP_DIR/key.pem" \
  -out "$TEMP_DIR/cert.pem" >/dev/null 2>&1
security import "$TEMP_DIR/key.pem" \
  -k "$HOME/Library/Keychains/login.keychain-db" \
  -T /usr/bin/codesign >/dev/null
security import "$TEMP_DIR/cert.pem" \
  -k "$HOME/Library/Keychains/login.keychain-db" >/dev/null
printf '%s\n' "Created signing identity: $IDENTITY"
