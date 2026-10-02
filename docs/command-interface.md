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
| Float/tile                     | `wm window <float\|tile> [--window <id>]`                       |
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
Host and service commands use the same parser but dispatch outside the engine.
Scenarios support simulated service start/stop/restart, not native host actions.

The shared command specification also supplies CLI help, documentation examples
and the playground's guided command choices.

## Compact and verbose CLI output

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
