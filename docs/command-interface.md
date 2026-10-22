# Command interface

Window commands act on windows; workspace commands act on workspaces. The CLI,
keybindings and scenario steps share one portable TypeScript parser in
`packages/layout/src/command-syntax.ts`. No command text is executed as a shell.

## Public vocabulary

| Operation                      | Command                                                         |
| ------------------------------ | --------------------------------------------------------------- |
| List windows                   | `wm window list`                                                |
| Observe a window               | `wm window observe [--window <id>]`                             |
| Focus a window                 | `wm window focus --window <id>`                                 |
| Focus a neighbor               | `wm window focus <left\|right\|up\|down>`                       |
| Move directionally             | `wm window move <left\|right\|up\|down>`                        |
| Set position                   | `wm window move position <x> <y> [--window <id>]`               |
| Set size                       | `wm window resize <width> <height> [--window <id>]`             |
| Float/tile                     | `wm window <float\|tile> [--toggle] [--window <id>]`             |
| Manage/unmanage                | `wm window <manage\|unmanage> [--window <id>]`                  |
| Assign workspace               | `wm window assign <workspace> [--window <id>] [--no-follow]`    |
| List workspaces                | `wm workspace list`                                             |
| Focus workspace                | `wm workspace focus <workspace>`                                |
| Move workspace to display      | `wm workspace move display <display> [--workspace <workspace>]` |
| Move workspace to next display | `wm workspace move display next`                                |
| Set workspace mode             | `wm workspace mode <bsp\|floating> [--workspace <workspace>]`   |
| Retile workspace               | `wm workspace retile [--workspace <workspace>]`                 |
| List displays                  | `wm display list`                                               |
| Read manager state             | `wm state`                                                      |
| Reconcile                      | `wm reconcile`                                                  |
| Pause/toggle/resume            | `wm pause`, `wm pause --toggle`, `wm resume`                    |
| Validate configuration         | `wm config validate`                                            |
| Reload configuration           | `wm config reload [delta\|full]`                                |
| Report permissions             | `wm permissions`                                                |
| Request permissions            | `wm permissions request [--open-settings]`                      |
| Manage native service          | `wm service <install\|start\|stop\|restart\|status\|uninstall>` |
| Start daemon                   | `wm serve [--port <port>] [--observe-only] [--sidecar <path>]`  |

Omitted targets mean the focused window or workspace, resolved at execution.
`wm window float --toggle` floats a tiled window or tiles a floating one;
the state is read at execution, like other toggle commands.
`wm window focus --window <id>` focuses the window and the workspace that contains
it, revealing that workspace if it is parked. Clicking a managed window, switching
to it with Cmd+Tab, or selecting it from the Dock also focuses its workspace.
Global window focus comes from the frontmost application's focused-window
reference; focus flags from inactive applications do not select command targets.
For external activation of a parked workspace, wm restores the selected window
to its intended frame first, then parks the old workspace and reveals the other
members. An unchanged window size uses a position-only write.

Assignment follows and focuses the assigned window by default. `--no-follow`
keeps the source workspace visible; when assigning its focused window, focus
moves to a remaining source window if one exists. Target selection never changes
follow behavior. Configuration reload defaults to `delta`.

Limit probing and full-frame setting are internal engine APIs. They are unavailable
through public text commands and WebSocket requests. Public position and size
commands remain available separately. Old command spellings are not aliases.

## Parsing and JSON

`parseCommandTokens(tokens)` and `parseCommandText(text)` return
`Result<ParsedCommand, CommandParseError>`. Success is `{ ok: true, value }`;
failure is `{ ok: false, error }`, with a code, readable message and help text.
The CLI passes shell-tokenized arguments directly. Keybindings and scenarios
use the text tokenizer before the same token parser. Malformed quoting, invalid
values, unknown options and duplicate options return errors rather than throw.

For example, `wm window assign 2 --window w17 --no-follow` becomes:

```json
{
  "type": "moveWindowToWorkspace",
  "workspace": "2",
  "windowId": "w17",
  "follow": false
}
```

WebSocket clients submit this structured command directly in a request envelope.
The wire schema validates it; the engine applies it. Omitting `windowId` uses
the focused window, and omitting `follow` means `true`, just as in text commands.

Valued options become payload fields: `--window w12` supplies `"windowId"` and
`--workspace 2` supplies `"workspace"`. Boolean flags become payload fields too:
`--no-follow` sets `"follow": false`, and `--toggle` sets `"toggle": true`.
`wm window float --toggle --window w12` becomes:

```json
{
  "type": "floatWindow",
  "windowId": "w12",
  "toggle": true
}
```

The engine resolves `"toggle": true` against committed state at execution —
it tiles a floating window and floats a tiled one — and, like other toggle
commands, a pending toggle is never coalesced with another. Without `"toggle"`,
the same words parse to a plain `"floatWindow"`. Boolean flags take no value,
so `--toggle=true` is an option error. Transport flags (`--verbose`, `--port`,
`--url`, `--sidecar`) configure the CLI itself and never appear in command
payloads.

Host and service commands use the same parser but dispatch outside the engine.
Scenarios support simulated service start/stop/restart, not native host actions.

The shared command specification also supplies CLI help, documentation examples
and the playground's guided command choices.

## Compact and verbose CLI output

### Observe a window

`wm window observe --window <id>` performs a fresh read through the native host.
It is read-only and remains available while wm is paused. The response includes:

- `window`: live window facts and committed workspace membership; `null` if the
  native window cannot currently be read.
- `cachedWindow`: the engine observation captured before the native read, for
  comparison. Observation does not replace that cached state.
- `diagnostics` on macOS: reader PID, bundle identity and privacy grants; target
  app registration/activation policy; NSWorkspace foreground PID before and after
  queries; resolution errors; and individual AX query results.

Each query reports its `scope`, `attribute`, numeric `errorCode`, readable
`errorName`, `valueType`, and `value`. Failed queries have `value: null`; unsupported
attributes are not interpreted as `false`. Window-local `AXFocused`/`AXMain`,
application `AXFrontmost`/`AXFocusedWindow`, and system-wide `AXFocusedApplication`/
`AXFocusedUIElement` are separate. Element values contain PID and target-match
facts, not pointers or text-field contents.

Details are included without `--verbose`; adding it preserves the transport
envelope. Adapters without native diagnostics still return a fresh window read.
Queries run sequentially, so this is a best-effort inspection rather than an
atomic macOS snapshot.

#### Platform-specific details: macOS

Use `wm window observe --pid <pid>` when a minimized or filtered window is absent
from wm's inventory. Choose either `--pid` or `--window`. PID observation leaves
`window` and `cachedWindow` null and exposes application evidence in `diagnostics`.
It does not select or focus a window, and requires native application-inspection
support from the platform adapter.

The application `AXWindows` query includes its raw status and returned count.
`diagnostics.rawWindows` contains each returned element before inventory filtering:
its array index, PID query status, target match, and individual window queries.
Indexes are local to this response, not stable window IDs. Windows are not dropped
because a geometry query fails. A failed or unsupported list read differs from a
successful list containing zero windows; inspect the query's status and value type.

`AXMinimized.settable`, `AXPosition.settable`, and `AXSize.settable` report whether
the app says those attributes can be changed. A successful true minimized result
means restoring from the Dock can be requested by setting `AXMinimized=false`;
it does not prove the write will succeed. Observe performs no restoration write.
Restoration is distinct from resizing, zooming, full-screen mode, and focus.

Apple API references:

| Data | API documentation |
| --- | --- |
| Raw application windows | [AXUIElementCreateApplication](https://developer.apple.com/documentation/applicationservices/1459374-axuielementcreateapplication), [AXWindows](https://developer.apple.com/documentation/applicationservices/kaxwindowsattribute) |
| Attribute values and raw errors | [AXUIElementCopyAttributeValue](https://developer.apple.com/documentation/applicationservices/1462085-axuielementcopyattributevalue), [Accessibility attributes](https://developer.apple.com/documentation/applicationservices/axattributeconstants_h) |
| Minimized state and settable checks | [AXMinimized](https://developer.apple.com/documentation/applicationservices/kaxminimizedattribute), [AXUIElementIsAttributeSettable](https://developer.apple.com/documentation/applicationservices/1459972-axuielementisattributesettable) |
| Restoration operation (not performed by observe) | [AXUIElementSetAttributeValue](https://developer.apple.com/documentation/applicationservices/1460434-axuielementsetattributevalue) |
| Window/app focus | [AXFocused](https://developer.apple.com/documentation/applicationservices/kaxfocusedattribute), [AXFrontmost](https://developer.apple.com/documentation/applicationservices/kaxfrontmostattribute), [AXFocusedWindow](https://developer.apple.com/documentation/applicationservices/kaxfocusedwindowattribute) |
| Global focus | [AXUIElementCreateSystemWide](https://developer.apple.com/documentation/applicationservices/1462095-axuielementcreatesystemwide), [AXFocusedApplication](https://developer.apple.com/documentation/applicationservices/kaxfocusedapplicationattribute), [AXFocusedUIElement](https://developer.apple.com/documentation/applicationservices/kaxfocuseduielementattribute) |
| App registration and foreground PID | [NSRunningApplication](https://developer.apple.com/documentation/appkit/nsrunningapplication), [NSWorkspace.frontmostApplication](https://developer.apple.com/documentation/appkit/nsworkspace/frontmostapplication) |
| Element identity | [AXUIElementGetPid](https://developer.apple.com/documentation/applicationservices/1460337-axuielementgetpid) |
| Observer grants | [AXIsProcessTrusted](https://developer.apple.com/documentation/applicationservices/1460720-axisprocesstrusted), [CGPreflightScreenCaptureAccess](https://developer.apple.com/documentation/coregraphics/cgpreflightscreencaptureaccess()) |

### Other command output

CLI commands print compact JSON by default. Add `--verbose` to any command to
retain the full response, including the protocol envelope, geometry, layout
trees, transaction information and diagnostic fields. The engine and WebSocket
API continue to return detailed structured results.

`wm window list` reports the currently focused workspace once, plus each
window's ID, title, app name and assigned workspace:

```json
{
  "currentWorkspace": "1",
  "windows": [
    {
      "id": "window:1",
      "title": "Project",
      "appName": "Editor",
      "assignedWorkspace": "2"
    }
  ]
}
```

Here, workspace 1 is focused, while the window belongs to workspace 2.
Unknown titles/app names and missing workspace assignments are `null`.

`wm workspace list` reports workspace names, display assignment and visibility,
plus member windows as title/app-name pairs:

```json
{
  "workspaces": [
    {
      "name": "2",
      "assignedDisplay": "display:main",
      "currentDisplay": null,
      "windows": [{ "title": "Project", "appName": "Editor" }]
    }
  ]
}
```

`assignedDisplay` uses an explicit move override, then configured display
preference; it is `null` when neither exists. `currentDisplay` is the display
currently showing the workspace, or `null` when the workspace is not visible.
Floating and tiled members are both included.

`wm state` gives manager status, focus and counts. `wm display list` gives display
IDs, primary-display status and frames. Successful mutations return
`{ "ok": true }`; validation includes issues when present. Errors retain their
code and message, and permission results retain any remediation guidance.

For example, `wm window list --verbose`, `wm workspace list --verbose` and
`wm state --verbose` provide the complete detailed output.
