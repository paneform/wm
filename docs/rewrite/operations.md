# TypeScript WM Operations

The production window manager is the TypeScript engine with the persistent
macOS sidecar. It listens on `127.0.0.1:17832`, loads
`~/.config/wm/config.jsonc`, and is supervised by the per-user launchd service
`com.allandeutsch.wm`.

Architectural rationale, including the native hotkey-monitor latency decision,
is recorded in [`docs/design-decisions.md`](../design-decisions.md).

```sh
swift build -c release --package-path packages/platform-macos/sidecar
scripts/package-local-wm-app.sh
scripts/wm-service.sh install
scripts/wm-service.sh status
scripts/wm-service.sh restart
scripts/wm-service.sh stop
```

Logs are under `${XDG_STATE_HOME:-~/.local/state}/wm/logs`. The service starts
the sidecar once and native keybind actions travel over its existing IPC pipe;
skhd must remain disabled to avoid duplicate bindings. Config changes hotload
without restarting the service.

The launchd-owned native host launches one TypeScript child over private inherited
protocol pipes. That child also runs the SketchyBar publisher, which converts
TypeScript state to the existing bar snapshot shape and triggers
`wm_workspace_change` after atomic snapshot writes.

The local package script creates an ad-hoc signed development bundle at
`~/.local/libexec/wm/WM.app`. Repackaging changes its code identity and requires
refreshing macOS privacy grants. Release distribution instead uses the durable
Developer ID and notarization workflow tracked by `wm-v9ea`.
