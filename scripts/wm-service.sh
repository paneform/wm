#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.allandeutsch.wm"
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LEGACY_BRIDGE_LABEL="$LABEL.sketchybar"
LEGACY_BRIDGE_PLIST="$HOME/Library/LaunchAgents/$LEGACY_BRIDGE_LABEL.plist"
CONFIG="${WM_CONFIG:-$HOME/.config/wm/config.jsonc}"
SIDECAR="${WM_NATIVE_HOST:-$HOME/.local/libexec/wm/WM.app/Contents/MacOS/wm}"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/wm"
NODE="$(command -v node)"
SERVICE_PATH="$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

write_plist() {
  local temporary
  mkdir -p "$HOME/Library/LaunchAgents" "$STATE/logs"
  temporary="$(mktemp "$HOME/Library/LaunchAgents/.wm.XXXXXX.plist")"
  cat >"$temporary" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$SIDECAR</string><string>host</string>
    <string>--node</string><string>$NODE</string>
    <string>--entry</string><string>$ROOT/packages/node-host/src/cli.ts</string>
    <string>--config</string><string>$CONFIG</string>
    <string>--port</string><string>17832</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$SERVICE_PATH</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>Crashed</key><true/><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$STATE/logs/daemon.stdout.log</string>
  <key>StandardErrorPath</key><string>$STATE/logs/daemon.stderr.log</string>
</dict></plist>
EOF
  plutil -lint "$temporary" >/dev/null
  chmod 600 "$temporary"
  mv "$temporary" "$PLIST"
}

graceful_stop() {
  local parent_pid="" child_pid="" line candidate
  while IFS= read -r line; do
    if [[ "$line" =~ ^[[:space:]]*pid[[:space:]]*=[[:space:]]*([0-9]+)$ ]]; then
      parent_pid="${BASH_REMATCH[1]}"
      break
    fi
  done < <(launchctl print "$DOMAIN/$LABEL" 2>/dev/null || true)
  [[ -n "$parent_pid" ]] || return

  while IFS= read -r candidate; do
    child_pid="$candidate"
    break
  done < <(pgrep -P "$parent_pid" -f "$ROOT/packages/node-host/src/cli.ts serve" || true)
  [[ -n "$child_pid" ]] || return

  kill -TERM "$child_pid" 2>/dev/null || return
  for ((attempt = 0; attempt < 600; attempt += 1)); do
    kill -0 "$child_pid" 2>/dev/null || return
    sleep 0.1
  done
}

unload() {
  launchctl bootout "$DOMAIN/$LEGACY_BRIDGE_LABEL" >/dev/null 2>&1 || true
  graceful_stop
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
}

load() {
  launchctl bootstrap "$DOMAIN" "$PLIST"
}

case "${1:-}" in
  install)
    [[ -x "$ROOT/scripts/wm-ts" && -x "$SIDECAR" ]] || {
      echo "native host not packaged; run scripts/package-local-wm-app.sh" >&2
      exit 1
    }
    [[ -r "$CONFIG" ]] || { echo "config not found: $CONFIG" >&2; exit 1; }
    write_plist
    unload
    rm -f "$LEGACY_BRIDGE_PLIST"
    load
    ;;
  start) load ;;
  stop) unload ;;
  restart)
    unload
    load
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL"
    "$ROOT/scripts/wm-ts" state --port 17832
    ;;
  uninstall)
    unload
    rm -f "$PLIST" "$LEGACY_BRIDGE_PLIST"
    ;;
  *) echo "usage: scripts/wm-service.sh install|start|stop|restart|status|uninstall" >&2; exit 2 ;;
esac
