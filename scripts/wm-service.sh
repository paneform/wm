#!/usr/bin/env bash
set -euo pipefail
umask 077

LABEL="com.paneform.wm"
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LEGACY_LABEL="com.allandeutsch.wm"
LEGACY_PLIST="$HOME/Library/LaunchAgents/$LEGACY_LABEL.plist"
LEGACY_APP="$HOME/.local/libexec/wm/WM.app"
LEGACY_BRIDGE_IDENTITY="$LEGACY_LABEL.sketchybar"
LEGACY_BRIDGE_IDENTITY_PLIST="$HOME/Library/LaunchAgents/$LEGACY_BRIDGE_IDENTITY.plist"
LEGACY_BRIDGE_LABEL="$LABEL.sketchybar"
LEGACY_BRIDGE_PLIST="$HOME/Library/LaunchAgents/$LEGACY_BRIDGE_LABEL.plist"
CONFIG="${WM_CONFIG:-$HOME/.config/wm/config.jsonc}"
SIDECAR="${WM_NATIVE_HOST:-$HOME/.local/libexec/wm/wm.app/Contents/MacOS/wm}"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/wm"
SERVICE_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

for path in "$CONFIG" "$SIDECAR" "$STATE"; do
  [[ "$path" = /* ]] || { echo "wm service paths must be absolute: $path" >&2; exit 1; }
done

write_plist() {
  local temporary
  mkdir -p "$HOME/Library/LaunchAgents" "$STATE/logs"
  temporary="$(mktemp "$HOME/Library/LaunchAgents/.wm.XXXXXX.plist")"
  plutil -create xml1 "$temporary"
  plutil -insert Label -string "$LABEL" "$temporary"
  plutil -insert ProgramArguments -json '[]' "$temporary"
  plutil -insert ProgramArguments.0 -string "$SIDECAR" "$temporary"
  plutil -insert ProgramArguments.1 -string host "$temporary"
  plutil -insert ProgramArguments.2 -string --config "$temporary"
  plutil -insert ProgramArguments.3 -string "$CONFIG" "$temporary"
  plutil -insert ProgramArguments.4 -string --port "$temporary"
  plutil -insert ProgramArguments.5 -string 17832 "$temporary"
  plutil -insert EnvironmentVariables -json '{}' "$temporary"
  plutil -insert EnvironmentVariables.PATH -string "$SERVICE_PATH" "$temporary"
  plutil -insert RunAtLoad -bool true "$temporary"
  plutil -insert KeepAlive -json '{}' "$temporary"
  plutil -insert KeepAlive.Crashed -bool true "$temporary"
  plutil -insert KeepAlive.SuccessfulExit -bool false "$temporary"
  plutil -insert ProcessType -string Interactive "$temporary"
  plutil -insert StandardOutPath -string "$STATE/logs/daemon.stdout.log" "$temporary"
  plutil -insert StandardErrorPath -string "$STATE/logs/daemon.stderr.log" "$temporary"
  plutil -lint "$temporary" >/dev/null
  chmod 600 "$temporary"
  mv "$temporary" "$PLIST"
}

migrate_legacy_identity() {
  local current_app="${SIDECAR%/Contents/MacOS/wm}" found=false legacy_app_is_distinct=false
  if [[ -e "$LEGACY_APP" ]] && { [[ ! -e "$current_app" ]] || [[ ! "$LEGACY_APP" -ef "$current_app" ]]; }; then
    legacy_app_is_distinct=true
  fi
  if [[ -e "$LEGACY_PLIST" || -e "$LEGACY_BRIDGE_IDENTITY_PLIST" || "$legacy_app_is_distinct" == true ]] ||
    launchctl print "$DOMAIN/$LEGACY_LABEL" >/dev/null 2>&1 ||
    launchctl print "$DOMAIN/$LEGACY_BRIDGE_IDENTITY" >/dev/null 2>&1; then
    found=true
  fi
  [[ "$found" == true ]] || return 0

  launchctl bootout "$DOMAIN/$LEGACY_LABEL" >/dev/null 2>&1 || true
  launchctl bootout "$DOMAIN/$LEGACY_BRIDGE_IDENTITY" >/dev/null 2>&1 || true
  rm -f "$LEGACY_PLIST" "$LEGACY_BRIDGE_IDENTITY_PLIST"
  if [[ "$legacy_app_is_distinct" == true ]]; then rm -rf "$LEGACY_APP"; fi
  tccutil reset Accessibility "$LEGACY_LABEL" >/dev/null 2>&1 || true
  tccutil reset ScreenCapture "$LEGACY_LABEL" >/dev/null 2>&1 || true
  tccutil reset ListenEvent "$LEGACY_LABEL" >/dev/null 2>&1 || true
}

graceful_stop() {
  local parent_pid="" line
  while IFS= read -r line; do
    if [[ "$line" =~ ^[[:space:]]*pid[[:space:]]*=[[:space:]]*([0-9]+)$ ]]; then
      parent_pid="${BASH_REMATCH[1]}"
      break
    fi
  done < <(launchctl print "$DOMAIN/$LABEL" 2>/dev/null || true)
  [[ -n "$parent_pid" ]] || return 0

  kill -TERM "$parent_pid" 2>/dev/null || return 0
  for ((attempt = 0; attempt < 600; attempt += 1)); do
    kill -0 "$parent_pid" 2>/dev/null || return 0
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
    [[ -x "$SIDECAR" ]] || {
      echo "native host not packaged; run scripts/package-local-wm-app.sh" >&2
      exit 1
    }
    [[ -r "$CONFIG" ]] || { echo "config not found: $CONFIG" >&2; exit 1; }
    migrate_legacy_identity
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
    "$SIDECAR" state --port 17832
    ;;
  uninstall)
    unload
    rm -f "$PLIST" "$LEGACY_BRIDGE_PLIST"
    ;;
  *) echo "usage: wm service install|start|stop|restart|status|uninstall" >&2; exit 2 ;;
esac
