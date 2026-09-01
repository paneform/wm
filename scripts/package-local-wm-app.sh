#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$ROOT/packages/platform-macos/sidecar/.build/release/wm-sidecar"
NODE_RUNTIME="${WM_NODE_RUNTIME:-$(command -v node)}"
PATH="/usr/bin:/bin:/usr/sbin:/sbin"
export PATH
APP_ROOT="$HOME/.local/libexec/wm"
APP="${WM_APP_PATH:-$APP_ROOT/wm.app}"
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
[[ "$NODE_RUNTIME" = /* && -x "$NODE_RUNTIME" ]] || {
  echo "WM_NODE_RUNTIME must be an absolute executable path" >&2
  exit 1
}
NODE_RUNTIME="$(realpath "$NODE_RUNTIME")"
[[ -f "$NODE_RUNTIME" && ! -L "$NODE_RUNTIME" ]] || {
  echo "Node runtime must resolve to a regular file" >&2
  exit 1
}
codesign --verify --strict \
  -R='anchor apple generic and certificate leaf[subject.OU] = "HX7739G8FX" and identifier "node"' \
  "$NODE_RUNTIME"
node_signature="$(codesign -dv --verbose=2 "$NODE_RUNTIME" 2>&1)"
[[ "$node_signature" == *"Identifier=node"* && "$node_signature" == *"TeamIdentifier=HX7739G8FX"* ]] || {
  echo "Node runtime must be signed by the Node.js Foundation" >&2
  exit 1
}
while IFS= read -r dependency; do
  dependency="${dependency#${dependency%%[![:space:]]*}}"
  [[ "$dependency" == "$NODE_RUNTIME:" || "$dependency" == /System/Library/* || "$dependency" == /usr/lib/* ]] || {
    echo "Node runtime has an external dependency: $dependency" >&2
    exit 1
  }
done < <(otool -L "$NODE_RUNTIME")
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
RESOURCES="$CONTENTS/Resources"
RUNTIME="$RESOURCES/node"
ENTRY="$RESOURCES/cli.mjs"
SERVICE_SCRIPT="$RESOURCES/wm-service.sh"
mkdir -p "$CONTENTS/MacOS" "$RESOURCES"
cp "$SOURCE" "$EXECUTABLE"
cp "$NODE_RUNTIME" "$RUNTIME"
cp "$ROOT/scripts/wm-service.sh" "$SERVICE_SCRIPT"
cmp -s "$NODE_RUNTIME" "$RUNTIME" || {
  echo "staged Node runtime does not match its verified source" >&2
  exit 1
}
codesign --verify --strict \
  -R='anchor apple generic and certificate leaf[subject.OU] = "HX7739G8FX" and identifier "node"' \
  "$RUNTIME"
[[ "$("$RUNTIME" --version)" == v24.* ]] || {
  echo "Node runtime must be version 24" >&2
  exit 1
}
chmod 700 "$EXECUTABLE"
chmod 700 "$RUNTIME"
env -i HOME="$HOME" PATH="/usr/bin:/bin" \
  "$RUNTIME" "$ROOT/scripts/bundle-cli.mjs" "$ENTRY"
chmod 600 "$ENTRY"
chmod 600 "$SERVICE_SCRIPT"
env -i HOME="$HOME" PATH="/usr/bin:/bin" "$RUNTIME" "$ENTRY" --help >/dev/null
cat >"$CONTENTS/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.paneform.wm</string>
  <key>CFBundleName</key><string>wm</string>
  <key>CFBundleDisplayName</key><string>wm</string>
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
codesign --verify --strict "$RUNTIME"
app_codesign_options=(--force --options runtime --sign "$SIGNING_FINGERPRINT" --identifier com.paneform.wm)
if [[ -n "$SIGNING_KEYCHAIN" ]]; then
  app_codesign_options+=(--keychain "$SIGNING_KEYCHAIN")
fi
codesign "${app_codesign_options[@]}" "$STAGED_APP"
codesign --verify --deep --strict "$STAGED_APP"

if [[ -e "$APP" ]]; then mv "$APP" "$BACKUP_APP"; fi
mv "$STAGED_APP" "$APP"
if ! (mkdir -p "$HOME/.local/bin" && ln -sfn "$APP/Contents/MacOS/wm" "$HOME/.local/bin/wm"); then
  rm -rf "$APP"
  if [[ -e "$BACKUP_APP" ]]; then mv "$BACKUP_APP" "$APP"; fi
  exit 1
fi
rm -rf "$BACKUP_APP"
printf '%s\n' "$APP"
printf '%s\n' "$HOME/.local/bin/wm"
