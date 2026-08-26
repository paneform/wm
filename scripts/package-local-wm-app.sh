#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$ROOT/packages/platform-macos/sidecar/.build/release/wm-sidecar"
APP="${WM_APP_PATH:-$HOME/.local/libexec/wm/WM.app}"
CONTENTS="$APP/Contents"
EXECUTABLE="$CONTENTS/MacOS/wm"

[[ -x "$SOURCE" ]] || { echo "release sidecar not built: $SOURCE" >&2; exit 1; }
rm -rf "$APP"
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
codesign --force --sign - --identifier com.allandeutsch.wm "$APP"
codesign --verify --deep --strict "$APP"
printf '%s\n' "$APP"
