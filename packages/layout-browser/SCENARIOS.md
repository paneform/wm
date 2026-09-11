# Portable layout scenarios

A layout scenario is JSON data that describes one exact starting scene and an optional sequence of inputs. It is suitable for demos, regression tests, editor completion, and AI-assisted authoring. It has no version field.

Use the published `@paneform/layout-browser/scenario.schema.json` file in an editor. For files authored outside the site, use `https://paneform.com/wm/play/scenario.schema.json`. TypeScript consumers can use `LayoutScenario`, `SimulationState`, `SimulationWindow`, `SimulationDisplay`, `ScenarioStep`, `ScenarioEvent`, and `ScenarioExpectation` from `@paneform/layout-browser`.

```json
{
  "$schema": "https://paneform.com/wm/play/scenario.schema.json",
  "state": {
    "topology": [
      {
        "id": "display:main",
        "frame": { "x": 0, "y": 0, "width": 1440, "height": 900 },
        "workArea": { "x": 0, "y": 24, "width": 1440, "height": 876 },
        "workspace": "1",
        "primary": true
      }
    ],
    "windows": [
      {
        "id": "editor",
        "title": "Scenario editor",
        "frame": { "x": 120, "y": 90, "width": 900, "height": 650 },
        "constraints": { "minWidth": 480, "minHeight": 320 }
      }
    ],
    "focusedWindow": "editor",
    "focusedWorkspace": "1"
  },
  "steps": [
    {
      "caption": "Put every pane in its place.",
      "command": "retile 1",
      "duration": 900,
      "expect": { "focusedWindow": "editor" }
    },
    {
      "event": { "kind": "focus_changed", "windowId": null },
      "expect": { "focusedWindow": null }
    }
  ]
}
```

## State

`state` is required. `config`, `presentation`, and `steps` are optional. `$schema` is only an editor hint and does not change runtime behavior.

Portable documents are limited to 100 initial or live windows, 16 displays, and 500 steps. Configuration is limited to 100 workspaces, 16 display entries, 100 assignment matchers per workspace, and 500 key bindings. An expectation can name at most 100 windows.

Display workspaces and window workspaces define the workspace names in the imported scene. A missing window `workspace` means `"1"`; an explicit `null` means the window is unassigned. A display always has a `workspace`, which may be `null`. There is no separate workspace collection and no public BSP history. If no display is marked primary, the runner treats the first display as primary.

Missing `focusedWindow` and `focusedWorkspace` values mean `null`, not an inferred focus. Non-null initial focus values must refer to an initial window or a workspace derived from the state. Import preserves the frames and policy facts in the document exactly. It does not restore prior split decisions, transaction history, or other hidden engine state.

For non-overlapping arrangements with full separating borders, inferred BSP intent follows those borders rather than splitting the window list by count. A 40/60 column split with a 70/30 stack in the right column remains that shape after focus changes or workspace roundtrips. Subsequent tiling adjusts for configured gaps, margins, constraints, and available display space. Overlapping or non-slicing arrangements use a deterministic fallback; their exact imported frames need not survive a later tiling operation.

An omitted `wmRunning` value means `true` for existing scenarios. When it is `false`, no engine exists: snapshots still report physical windows, focus, topology, constraints, and saved workspace membership. A stopped manager is never paused, so `wmRunning: false` with `paused: true` is invalid. Physical events remain available while stopped. Starting or restarting the service creates an ordinary fresh engine with no imported layout checkpoint. Startup discovers the current physical desktop, applies configuration assignments, and performs its normal initial layout. In contrast, a document that initially has `wmRunning: true` uses exact hydration so its supplied frames and memberships are not rewritten on load.

Window constraints are simulated platform truth. They are not preloaded as layout-engine knowledge. Each minimum or maximum is optional and independent, and missing constraints remain unmodeled. A minimum cannot exceed the corresponding maximum.

Frames and size limits use logical screen points, not device pixels. The primary display's top-left is the origin; positive Y points down. Other displays and offscreen windows may have negative coordinates. An omitted work area uses the full display frame, and an omitted scale defaults to 1. Initial frames may fall outside supplied size limits; importing does not clamp them.

## Steps and events

Every step contains exactly one `command` or one `event`. Commands use the `wm` CLI grammar but are parsed directly as data. They are never passed to a shell. `reload-config` reloads the scenario's in-memory immutable config; it does not read a path. Host-only subscriptions are not supported.

The simulator also handles `service start`, `service stop`, and `service restart`, each with an optional `wm` prefix. These commands only control the simulator lifecycle and never invoke a shell or native IPC. Start and stop are idempotent. Other WM commands fail with code `wm_not_running` while stopped and can assert that result with `expect.error`.

Events use the platform names `window_added`, `window_changed`, `window_removed`, `focus_changed`, `topology_changed`, `space_changed`, `sleep`, and `wake`. Added and changed windows contain physical facts only: no workspace or floating policy. A changed window's omitted metadata remains unchanged. `topology_changed` supplies the complete connected physical topology and replaces the prior topology. It does not assign workspaces.

A step settles after the runner has awaited the input and all work scheduled by that input. The runner does not perform an extra hidden reconcile. `caption` and `duration` are presentation-only. `expect` can check selected state, including `wmRunning`, or name an expected command error code. An expectation may refer to a removed window only when it asserts `exists: false`.

## Presentation

`presentation` is ignored by the headless runner. It keeps UI choices separate from WM configuration. `device` defaults to `"laptop"`; `devices` can override the shell for up to 16 known display IDs with `"laptop"` or `"display"`. Overrides may refer to displays introduced by a later topology step. Unknown display IDs and the reserved key `__proto__` are rejected.

`showKeyboard`, `showDock`, `showTopBar`, `allowMove`, `allowResize`, and `animate` all default to `true`. The keyboard option applies only to laptops; standalone displays never include a keyboard. Visibility options do not alter display work areas or other physical state. `animate: false` makes the player apply steps without key animations, window transitions, or presentation delays.

## Playground and authoring

`/wm/play/` opens an empty laptop with its keyboard, dock, and top bar visible and the WM stopped. `/wm/play/hero/` uses the same player for the hero sequence. Both reuse the device shells and window gestures from `/wm/`.

The playground records interactions immediately against its original starting state. The default starts with an empty desktop and `wmRunning: false`: launches, focus, moves, resizes, and closes are recorded as physical events even before Paneform starts. Starting Paneform records a separate `service start` command that applies ordinary startup policy. Replay can therefore reproduce the exact desktop before startup and the layout produced by startup. A running manager processes setup events through normal policy rather than merely saving raw frames for later repair.

Dock launches record one **Open App** step: a `window_added` event with `focus: true`. The simulator creates and focuses the window before settling that step, so replay does not stop with the new window behind the previous one. Omitting `focus` (or setting it to `false`) retains ordinary window-add behavior for background-window reproductions. Standalone `focus_changed` events remain available for independent focus changes.

Clicking a window focuses it and opens its size limits beside the display. On narrow screens the inspector becomes a bounded, scrollable sheet. A blank limit is unspecified, not zero. Constraint edits are physical `window_changed` steps; configuration and presentation remain document-level settings.

**Add command** opens an empty, typed command builder. It first offers command groups, then only the valid subcommands and arguments for the selected path. Space accepts the highlighted token; Enter inserts a complete command into the local step drafts. For example, type `window move left` and press Enter. Window and display arguments use known references; workspace names and numbers are entered only in their appropriate slots. Quoted names preserve spaces and special characters.

Incomplete searches never become scenario steps or schema errors. Finish or cancel an open command before choosing **Apply steps**. The same builder edits existing commands, and suggestions use the preceding draft steps. The editor shows 20 steps per page and at most 50 choices at one position. Completed commands still use the shared CLI parser; runtime failures such as `wm_not_running` remain testable with expectations.

At Start, a paused cursor, or the end of playback, desktop actions are recorded immediately after the current step. Workspace-bar navigation and hotkeys record their commands; window focus, close, drag, resize, and launch record physical events. The original starting state and remaining sequence are preserved, including captions and expectations. An action that invalidates a later reference is rejected before execution. Apply draft changes before playback or recording desktop actions so unsaved edits are not overwritten.

Steps remain editable after playback. Appending or editing only future steps keeps the current layout and cursor; changing an executed step resets playback to the start. If a failed step may already have changed runtime state, applying edited steps also resets the session rather than retaining a state that no longer matches replay. Failed or superseded saves retain unsaved edits.

Dragging and resizing simulate physical window changes, not strict `debug-frame` commands. Offscreen gestures therefore do not produce a false geometry-write failure. The running window manager can still retile the resulting scene; paused or stopped scenes retain physical edits without repair policy.

Choose **Load local config** to import a JSON/JSONC config and its hotkeys. The canonical native location is `~/.config/paneform/wm/config.jsonc`; `WM_CONFIG` and `XDG_CONFIG_HOME` can select other locations. The browser cannot preselect an arbitrary local directory or file. Its picker remembers the previously used folder where supported; on macOS, Command-Shift-G opens the path entry. A standard file input is used when the extended picker is unavailable. Loading config resets playback and rejects invalid or oversized files without replacing the active session.

Click the desktop before using physical hotkeys. Bindings are inactive in text fields and during playback, and explicit config bindings replace the demo defaults. Generic Shift, Control, Option/Alt, and Command modifiers accept either side; `lshift`/`rshift`, `lcontrol`/`rcontrol`, `loption`/`roption`, and `lcommand`/`rcommand` distinguish physical sides by tracking modifier keydown/keyup events. Sided bindings match the exact requested sides, including chords requiring both sides. Tracking clears when the page loses focus or is hidden. Fn is matched when the browser exposes its event or modifier state; browser/OS-reserved shortcuts may remain unavailable. Invalid chords and unsupported actions are listed rather than executed approximately. Imported config stays client-side, but is included in exported JSON and shared scenario links.

Playback does not rewrite the authored starting state. **Return to start** returns to it; subsequent actions insert before the first step. **Use current layout as new start** is the explicit operation that replaces the baseline and clears previous setup history. Export and share always retain the baseline and recorded sequence, including pre-WM setup.

Step headings edit the caption directly. Drag a handle to reorder, or focus it and use Space/Enter to pick up/drop, arrow keys to move, and Escape to cancel. Pointer cancellation also restores the prior order. Trash buttons remove steps. Clicking a command opens the token builder; hovering its segments describes commands and variable roles. Those descriptions come from the portable `commandPaths`/`serviceCommandPaths` metadata in `@paneform/layout`, also used for CLI help (including `wm workspace move-window --help`) and available to documentation generators. The browser exposes `scenarioCommandPaths` and `describeScenarioCommandTokens` for its supported service subset.

The dock sizes itself relative to the screen and its reserved bottom strip. New playground desktop displays reserve space below the work area. Imported displays with no bottom reservation keep their physical geometry and use a compact overlay instead; showing the dock does not silently resize imported layouts.

Directional focus uses window borders and does not wrap at an edge. Directional moves use visible geometry. The upstream group-movement experiment can be enabled with `config.experiments.directionalMoveGroups: true`.

## Runner API

The runner is designed for headless tests and interactive playback:

```ts
runScenario(document): Promise<SimulationState>

createScenarioSession(document): Promise<ScenarioSession>

interface ScenarioSession {
  readonly engine: Engine | null
  snapshot(): Promise<SimulationState>
  apply(step: ScenarioStep): Promise<SimulationState>
  step(): Promise<{ index: number; step: ScenarioStep; state: SimulationState } | null>
  run(): Promise<SimulationState>
  dispose(): Promise<void>
}
```

The document is an exact import, not a recording of native desktop history. Session operations are processed in FIFO order. `apply` validates one live input against the current window and display IDs and returns its settled state. A rejected live input does not block later edits. An unexpected scripted `step` or `run` failure stops that script for the session.

`parseScenario` performs the semantic checks that JSON Schema cannot express, including command syntax, live references, unique identifiers, presentation display references, lifecycle consistency, and related minimum and maximum values. JSON Schema validation alone checks only the documented structure and field bounds. `parseScenarioCommand` exposes the same service-or-WM parser for autocomplete and validation tools. Headless `runScenario` calls are intended for trusted tests. Browser playback of user-authored scenarios runs in an isolated worker; terminating that worker remains the hard-stop mechanism for CPU stalls.

## Sharing and privacy

Scenario files are data-only and cannot invoke a shell. They do not automatically capture native identifiers or executable paths. Manually entered titles, bundle identifiers, executable paths in configuration matchers, captions, and other configuration can still contain sensitive information. Review a scenario before sharing it.

**Copy share link** encodes the full validated document as UTF-8 JSON, gzip, and base64url in `#scenario=gz.<data>`. Fragments are not included in HTTP requests. Links do not autoplay. The player limits encoded fragments to 32 KiB and stops decompression at 1 MiB; use JSON for larger cases. Compression is not encryption: recipients and browser history can still retain the full scenario.
