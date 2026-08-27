#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$ROOT/packages/platform-macos/sidecar/.build/release/wm-sidecar"
APP_ROOT="$HOME/.local/libexec/wm"
APP="${WM_APP_PATH:-$APP_ROOT/WM.app}"
SIGNING_SELECTOR="${WM_CODESIGN_IDENTITY:-WM Local Code Signing}"
SIGNING_KEYCHAIN="${WM_CODESIGN_KEYCHAIN:-}"
SIGNING_SELECTOR_LOWER="$(printf '%s' "$SIGNING_SELECTOR" | tr '[:upper:]' '[:lower:]')"
LOCK_KEYCHAIN=false

cleanup() {
  if [[ "$LOCK_KEYCHAIN" == true ]]; then
    security lock-keychain "$SIGNING_KEYCHAIN" >/dev/null 2>&1 || true
  fi
  preserve_temporary=false
  if [[ -n "${BACKUP_APP:-}" && -e "$BACKUP_APP" && ! -e "$APP" ]]; then
    if ! mv "$BACKUP_APP" "$APP"; then
      printf '%s\n' "failed to restore previous app; backup retained at $BACKUP_APP" >&2
      preserve_temporary=true
    fi
  fi
  if [[ "$preserve_temporary" == false && -n "${TEMPORARY:-}" ]]; then
    rm -rf "$TEMPORARY" || true
  fi
}
trap cleanup EXIT

[[ -x "$SOURCE" ]] || { echo "release sidecar not built: $SOURCE" >&2; exit 1; }
case "$APP" in
  "$APP_ROOT"/*.app)
    [[ "${APP#"$APP_ROOT"/}" != */* ]] || { echo "WM_APP_PATH must be directly under $APP_ROOT" >&2; exit 1; }
    ;;
  *) echo "WM_APP_PATH must be an app bundle directly under $APP_ROOT" >&2; exit 1 ;;
esac

if [[ -z "${WM_CODESIGN_IDENTITY+x}" && -z "${WM_CODESIGN_KEYCHAIN+x}" ]]; then
  SIGNING_KEYCHAIN="$HOME/Library/Keychains/wm-local-signing.keychain-db"
  [[ -e "$SIGNING_KEYCHAIN" ]] || {
    echo "local signing keychain not found: $SIGNING_KEYCHAIN" >&2
    echo "run scripts/create-local-signing-identity.sh" >&2
    exit 1
  }
  LOCK_KEYCHAIN=true
fi

list_identities() {
  if [[ -n "$SIGNING_KEYCHAIN" ]]; then
    security find-identity -v -p codesigning "$SIGNING_KEYCHAIN"
  else
    security find-identity -v -p codesigning
  fi
}

matches=()
while IFS= read -r line; do
  if [[ "$line" =~ ^[[:space:]]*[0-9]+\)[[:space:]]+([0-9A-Fa-f]{40})[[:space:]]+\"(.*)\"$ ]]; then
    fingerprint="${BASH_REMATCH[1]}"
    name="${BASH_REMATCH[2]}"
    fingerprint_lower="$(printf '%s' "$fingerprint" | tr '[:upper:]' '[:lower:]')"
    if [[ "$fingerprint_lower" == "$SIGNING_SELECTOR_LOWER" || "$name" == "$SIGNING_SELECTOR" ]]; then
      matches+=("$fingerprint")
    fi
  fi
done < <(list_identities)

if (( ${#matches[@]} != 1 )); then
  echo "expected one code-signing identity for '$SIGNING_SELECTOR', found ${#matches[@]}" >&2
  echo "run scripts/create-local-signing-identity.sh or set WM_CODESIGN_IDENTITY to an exact name or fingerprint" >&2
  exit 1
fi
SIGNING_FINGERPRINT="${matches[0]}"

mkdir -p "$APP_ROOT"
TEMPORARY="$(mktemp -d "$APP_ROOT/.wm-package.XXXXXX")"
STAGED_APP="$TEMPORARY/$(basename "$APP")"
BACKUP_APP="$TEMPORARY/previous.app"

CONTENTS="$STAGED_APP/Contents"
EXECUTABLE="$CONTENTS/MacOS/wm"
mkdir -p "$CONTENTS/MacOS"
cp "$SOURCE" "$EXECUTABLE"
chmod 700 "$EXECUTABLE"
cat >"$CONTENTS/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.allandeutsch.wm</string>
  <key>CFBundleName</key><string>WM</string>
  <key>CFBundleDisplayName</key><string>WM</string>
  <key>CFBundleExecutable</key><string>wm</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.0.1</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>NSAccessibilityUsageDescription</key><string>WM manages and focuses application windows.</string>
  <key>NSScreenCaptureUsageDescription</key><string>WM reads window metadata for window management.</string>
</dict></plist>
EOF
plutil -lint "$CONTENTS/Info.plist" >/dev/null
codesign_options=(--force --sign "$SIGNING_FINGERPRINT" --identifier com.allandeutsch.wm)
if [[ -n "$SIGNING_KEYCHAIN" ]]; then codesign_options+=(--keychain "$SIGNING_KEYCHAIN"); fi
codesign "${codesign_options[@]}" "$STAGED_APP"
codesign --verify --deep --strict "$STAGED_APP"

if [[ -e "$APP" ]]; then mv "$APP" "$BACKUP_APP"; fi
mv "$STAGED_APP" "$APP"
rm -rf "$BACKUP_APP"
printf '%s\n' "$APP"
