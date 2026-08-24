import type { Command } from "@wm/engine";

export interface ParsedArgs {
  command: Command | null;
  positional: string[];
  flags: Record<string, string | boolean>;
  help: boolean;
  serve: boolean;
}

/** Map CLI verb + args onto an engine Command. Returns null for unknown verbs. */
export function buildCommand(verb: string, rest: string[]): Command | null {
  const [a = "", b = "", c = ""] = rest;
  switch (verb) {
    case "state":
      return { type: "getState" };
    case "windows":
      return { type: "getWindows" };
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
    case "float":
      return a ? { type: "floatWindow", windowId: a } : null;
    case "tile":
      return a ? { type: "tileWindow", windowId: a } : null;
    case "manage":
      return a ? { type: "manageWindow", windowId: a } : null;
    case "unmanage":
      return a ? { type: "unmanageWindow", windowId: a } : null;
    case "workspace":
      if (a === "focus") return b ? { type: "focusWorkspace", name: b } : null;
      if (a === "move-window")
        return b && c ? { type: "moveWindowToWorkspace", windowId: b, workspace: c } : null;
      if (a === "move-display")
        return b && c ? { type: "moveWorkspaceToDisplay", workspace: b, displayId: c } : null;
      if (a === "mode") return b && c ? { type: "setWorkspaceMode", workspace: b, mode: c as "bsp" | "floating" } : null;
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

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let serve = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--port") flags["port"] = argv[++i] ?? "";
    else if (arg === "--url") flags["url"] = argv[++i] ?? "";
    else if (arg.startsWith("--")) flags[arg.slice(2)] = true;
    else positional.push(arg);
  }
  const verb = positional[0];
  if (verb === "serve") {
    serve = true;
    positional.shift();
  }
  const command = verb === undefined || help || serve ? null : buildCommand(verb, positional.slice(1));
  return { command, positional, flags, help, serve };
}

export const USAGE = `wm — macOS window manager

Client:
  wm <command> [args...]     Execute a command against the daemon over WebSocket
Commands:
  state | windows | displays | workspaces
  focus-window ID | move-window ID X Y | resize-window ID W H
  float ID | tile ID | manage ID | unmanage ID
  workspace focus NAME | workspace move-window ID NAME | workspace move-display WS DISPLAY
  retile [WS] | reconcile | pause | resume
  validate-config | reload-config [delta|full]
Daemon:
  wm serve [--port N]
Flags:
  --port N   Daemon WebSocket port (default from config or 17832)
  --help     Show this help`;
