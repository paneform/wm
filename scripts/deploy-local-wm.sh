#!/usr/bin/env bash
set -euo pipefail

# One-shot local deploy: build the release sidecar, stop the wm service,
# package and install the app (replacing the system `wm`), restart the
# service on the new binary, and verify the new daemon answers.
#
# Environment passes through to the packaging script: WM_CODESIGN_IDENTITY,
# WM_CODESIGN_KEYCHAIN, WM_NODE_RUNTIME, WM_APP_PATH.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIDECAR_PACKAGE="$ROOT/packages/platform-macos/sidecar"
SERVICE="$ROOT/scripts/wm-service.sh"
PACKAGE="$ROOT/scripts/package-local-wm-app.sh"
BIN="$HOME/.local/bin/wm"
APP="${WM_APP_PATH:-$HOME/.local/libexec/wm/wm.app}"
LABEL="com.paneform.wm"
DOMAIN="gui/$(id -u)"

step() { printf '\n== %s\n' "$1"; }

was_running=false
service_stopped=false
deployed=false

# Never leave wm down: if the service was running and a step fails after the
# stop, bring the previously installed build back up.
restore() {
  if [[ "$service_stopped" == true && "$deployed" == false && "$was_running" == true ]]; then
    printf '%s\n' "deploy failed; restarting the previously installed build" >&2
    "$SERVICE" start >/dev/null 2>&1 || true
  fi
}
trap restore EXIT

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then was_running=true; fi

step "Building release sidecar"
swift build -c release --package-path "$SIDECAR_PACKAGE"

if [[ "$was_running" == true ]]; then
  step "Stopping the wm service"
  "$SERVICE" stop
  service_stopped=true
fi

step "Packaging and installing the app (system wm -> $BIN)"
"$PACKAGE"

step "Starting the wm service"
"$SERVICE" start
service_stopped=false

step "Waiting for the new daemon"
healthy=false
for _ in $(seq 1 120); do
  if "$BIN" state >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 0.25
done
if [[ "$healthy" != true ]]; then
  echo "daemon did not answer within 30s; inspect ~/.local/state/wm/logs" >&2
  exit 1
fi
deployed=true

version="$(plutil -extract CFBundleShortVersionString raw -expect string -o - "$APP/Contents/Info.plist")"
printf '\nwm %s deployed and running\n  app:    %s\n  binary: %s\n' "$version" "$APP" "$BIN"
