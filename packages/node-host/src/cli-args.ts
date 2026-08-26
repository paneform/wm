import type { Command } from "@wm/engine";

/** Commands executed locally (sidecar spawn) instead of over the daemon WebSocket. */
export type LocalCommand = "doctor" | "permissions-request";

export interface ParsedArgs {
  command: Command | null;
  localCommand: LocalCommand | null;
  positional: string[];
  flags: Record<string, string | boolean>;
  help: boolean;
  serve: boolean;
}

const DIRECTIONS = ["left", "right", "up", "down"] as const;
type Direction = (typeof DIRECTIONS)[number];

const directionOf = (value: string): Direction | null =>
  (DIRECTIONS as readonly string[]).includes(value) ? (value as Direction) : null;

const finiteNumber = (value: string): number | null => {
  const number = Number(value);
  return value.length > 0 && Number.isFinite(number) ? number : null;
};

/** Map CLI verb + args onto an engine Command. Returns null for unknown verbs.
 * The CLI owns NO layout/directional policy — it only maps syntax onto
 * Command envelopes; the engine resolves focus/displays/neighbors.
 * `flags` carries boolean flags stripped from `rest` (e.g. --toggle). */
export function buildCommand(
  verb: string,
  rest: string[],
  flags: Record<string, string | boolean> = {},
): Command | null {
  // Exact-arity forms reject EXCESS positionals (review issue 6).
  const [a = "", b = "", c = "", d = ""] = rest;
  switch (verb) {
    case "state":
      return { type: "getState" };
    case "windows":
      return { type: "getWindows" };
    case "observe-window":
      return a && !b ? { type: "getWindow", windowId: a } : null;
    case "displays":
      return { type: "getDisplays" };
    case "workspaces":
      return { type: "getWorkspaces" };
    case "focus-window":
      return a ? { type: "focusWindow", windowId: a } : null;
    case "move-window":
      return a && b !== undefined && c !== undefined
        ? { type: "moveWindow", windowId: a, point: { x: Number(b), y: Number(c) } }
        : null;
    case "resize-window":
      return a && b && c
        ? { type: "resizeWindow", windowId: a, size: { width: Number(b), height: Number(c) } }
        : null;
    case "debug-frame": {
      if (a !== "set" || !b || rest.length !== 6) return null;
      const values = rest.slice(2).map(finiteNumber);
      if (values.some((value) => value === null)) return null;
      const [x, y, width, height] = values as [number, number, number, number];
      return width > 0 && height > 0
        ? { type: "setWindowFrame", windowId: b, frame: { x, y, width, height } }
        : null;
    }
    case "float":
      return a ? { type: "floatWindow", windowId: a } : null;
    case "tile":
      return a ? { type: "tileWindow", windowId: a } : null;
    case "manage":
      return a ? { type: "manageWindow", windowId: a } : null;
    case "unmanage":
      return a ? { type: "unmanageWindow", windowId: a } : null;
    case "window": {
      if (a === "probe-limits") return b && !c ? { type: "probeWindowLimits", windowId: b } : null;
      if (!a || !b || c !== "") return null;
      const direction = directionOf(b);
      if (direction === null) return null;
      if (a === "focus") return { type: "focusDirection", direction };
      if (a === "move") return { type: "moveDirection", direction };
      return null;
    }
    case "workspace":
      if (a === "focus") return b && !c ? { type: "focusWorkspace", name: b } : null;
      if (a === "pause") return !b && flags["toggle"] === true ? { type: "togglePause" } : null;
      // skhd form: focused window follows the named workspace. The explicit
      // ID form (`workspace move-window ID NAME`) stays supported by arity.
      if (a === "move-window") {
        if (b && !c) return { type: "moveFocusedWindowToWorkspace", workspace: b };
        if (b && c && !d) return { type: "moveWindowToWorkspace", windowId: b, workspace: c };
        return null;
      }
      if (a === "move") {
        return b === "next" && !c ? { type: "moveFocusedWorkspaceToNextDisplay" } : null;
      }
      if (a === "move-display")
        return b && c && !d ? { type: "moveWorkspaceToDisplay", workspace: b, displayId: c } : null;
      if (a === "mode")
        return b && c && !d
          ? { type: "setWorkspaceMode", workspace: b, mode: c as "bsp" | "floating" }
          : null;
      return null;
    case "retile":
      return { type: "retile", ...(a ? { workspace: a } : {}) };
    case "reconcile":
      return { type: "reconcile" };
    case "pause":
      return { type: "pause" };
    case "resume":
      return { type: "resume" };
    case "validate-config":
      return { type: "validateConfig" };
    case "reload-config":
      return { type: "reloadConfig", ...(a ? { mode: a as "delta" | "full" } : {}) };
    default:
      return null;
  }
}

export function buildKeybindCommand(action: string): Command | null {
  const words = action.trim().split(/\s+/);
  if (words[0] === "window" && words[1] === "move" && words[2] === "workspace" && words[3] && !words[4]) {
    return { type: "moveFocusedWindowToWorkspace", workspace: words[3] };
  }
  const verb = words.shift();
  const flags: Record<string, boolean> = {};
  const positional = words.filter((word) => {
    if (!word.startsWith("--")) return true;
    flags[word.slice(2)] = true;
    return false;
  });
  return verb === undefined || verb.length === 0 ? null : buildCommand(verb, positional, flags);
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let serve = false;
  let help = false;
  let localCommand: LocalCommand | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--port") flags["port"] = argv[++i] ?? "";
    else if (arg === "--url") flags["url"] = argv[++i] ?? "";
    else if (arg === "--sidecar") flags["sidecar"] = argv[++i] ?? "";
    else if (arg.startsWith("--")) flags[arg.slice(2)] = true;
    else positional.push(arg);
  }
  const verb = positional[0];
  if (verb === "serve") {
    serve = true;
    positional.shift();
  } else if (verb === "doctor") {
    localCommand = "doctor";
  } else if (verb === "permissions" && positional[1] === "request") {
    localCommand = "permissions-request";
  }
  const command =
    verb === undefined || help || serve || localCommand !== null ?
      null
    : buildCommand(verb, positional.slice(1), flags);
  return { command, localCommand, positional, flags, help, serve };
}

export const USAGE = `wm — macOS window manager

Client:
  wm <command> [args...]     Execute a command against the daemon over WebSocket
Commands:
  state | windows | displays | workspaces
  observe-window ID                         Read one committed window observation
  debug-frame set ID X Y WIDTH HEIGHT       Explicit verified geometry write
  focus-window ID | move-window ID X Y | resize-window ID W H
  float ID | tile ID | manage ID | unmanage ID
  window focus left|right|up|down     Focus the spatial neighbor (wraps at edges)
  window move left|right|up|down      Swap the focused window with its neighbor
  window probe-limits WINDOW_ID       Reversibly measure window dimension limits
  workspace focus NAME | workspace pause --toggle
  workspace move-window NAME          Move the FOCUSED window to NAME and follow
  workspace move-window ID NAME       Move an explicit window ID to NAME
  workspace move next                 Move the focused workspace to the next display
  workspace move-display WS DISPLAY | workspace mode WS bsp|floating
  retile [WS] | reconcile | pause | resume
  validate-config | reload-config [delta|full]
Local (no daemon required):
  wm doctor                  Report macOS permissions as JSON; read-only
  wm permissions request     Trigger TCC prompts via the sidecar, then report status
                             (--open-settings deep links System Settings panes)
Daemon:
  wm serve [--port N] [--observe-only] [--sidecar PATH]
Flags:
  --port N        Daemon WebSocket port (default from config or 17832)
  --sidecar PATH  Explicit wm-sidecar executable for local commands
  --observe-only  Start paused: observe/query state without platform mutations
  --url WS-URL    Daemon WebSocket URL for client commands
  --help          Show this help`;
