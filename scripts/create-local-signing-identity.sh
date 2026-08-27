#!/usr/bin/env bash
set -euo pipefail
umask 077

IDENTITY="${WM_LOCAL_CODESIGN_IDENTITY:-WM Local Code Signing}"
KEYCHAIN="${WM_CODESIGN_KEYCHAIN:-$HOME/Library/Keychains/wm-local-signing.keychain-db}"
TEMPORARY="$(mktemp -d "${TMPDIR:-/tmp}/wm-signing.XXXXXX")"
CREATED_HASH=""
CREATED_KEYCHAIN=false
COMPLETE=false

cleanup() {
  if [[ "$COMPLETE" != true && -n "$CREATED_HASH" ]]; then
    security delete-identity -Z "$CREATED_HASH" -t "$KEYCHAIN" >/dev/null 2>&1 || true
  fi
  security lock-keychain "$KEYCHAIN" >/dev/null 2>&1 || true
  if [[ "$COMPLETE" != true && "$CREATED_KEYCHAIN" == true ]]; then
    security delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true
  fi
  rm -rf "$TEMPORARY"
}
trap cleanup EXIT

if [[ ! -e "$KEYCHAIN" ]]; then
  security create-keychain -P "$KEYCHAIN"
  CREATED_KEYCHAIN=true
  security set-keychain-settings -l -u -t 300 "$KEYCHAIN"
else
  security unlock-keychain "$KEYCHAIN"
fi

matches=()
while IFS= read -r line; do
  if [[ "$line" =~ ^[[:space:]]*[0-9]+\)[[:space:]]+([0-9A-Fa-f]{40})[[:space:]]+\"(.*)\"$ ]] &&
    [[ "${BASH_REMATCH[2]}" == "$IDENTITY" ]]; then
    matches+=("${BASH_REMATCH[1]}")
  fi
done < <(security find-identity -v -p codesigning "$KEYCHAIN")

if (( ${#matches[@]} == 1 )); then
  printf '%s\n' "code-signing identity already exists: $IDENTITY (${matches[0]})"
  COMPLETE=true
  exit 0
fi
if (( ${#matches[@]} > 1 )); then
  printf '%s\n' "multiple valid code-signing identities have this name: $IDENTITY" >&2
  exit 1
fi
existing_certificate="$(security find-certificate -a -c "$IDENTITY" -Z "$KEYCHAIN" 2>/dev/null || true)"
if [[ -n "$existing_certificate" ]]; then
  printf '%s\n' "a certificate named '$IDENTITY' exists but is not a valid code-signing identity" >&2
  printf '%s\n' "remove or repair that partial identity in Keychain Access before retrying" >&2
  exit 1
fi

PASSPHRASE="$(openssl rand -hex 32)"
openssl req -quiet -x509 -newkey rsa:3072 -sha256 -days 3650 \
  -subj "/CN=$IDENTITY/O=WM Local Development" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=codeSigning" \
  -passout fd:3 \
  -keyout "$TEMPORARY/key.pem" \
  -out "$TEMPORARY/certificate.pem" 3<<<"$PASSPHRASE"

openssl pkcs12 -export \
  -inkey "$TEMPORARY/key.pem" \
  -in "$TEMPORARY/certificate.pem" \
  -name "$IDENTITY" \
  -passin fd:3 \
  -passout fd:4 \
  -out "$TEMPORARY/identity.p12" 3<<<"$PASSPHRASE" 4<<<"$PASSPHRASE"

CREATED_HASH="$(openssl x509 -in "$TEMPORARY/certificate.pem" -noout -fingerprint -sha1)"
CREATED_HASH="${CREATED_HASH#*=}"
CREATED_HASH="${CREATED_HASH//:/}"
security import "$TEMPORARY/identity.p12" -k "$KEYCHAIN" -f pkcs12 \
  -P "$PASSPHRASE" -x
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" \
  "$TEMPORARY/certificate.pem"

if ! security find-identity -v -p codesigning "$KEYCHAIN" | while IFS= read -r line; do
  [[ "$line" == *"$CREATED_HASH"*"\"$IDENTITY\""* ]] && exit 0
done; then
  printf '%s\n' "created certificate is not a valid code-signing identity: $IDENTITY" >&2
  exit 1
fi

COMPLETE=true
printf '%s\n' "created code-signing identity: $IDENTITY ($CREATED_HASH)"
