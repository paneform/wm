import type { Command } from "./commands.js";

const DIRECTIONS = ["left", "right", "up", "down"] as const;
const FOCUS_RELATIONS = {
  left: "to the left of",
  right: "to the right of",
  up: "above",
  down: "below",
} as const;
type Direction = (typeof DIRECTIONS)[number];

export type CommandToken =
  | { readonly kind: "literal"; readonly value: string; readonly description?: string }
  | {
      readonly kind: "slot";
      readonly slot: "window" | "display" | "workspace" | "coordinate" | "dimension";
      readonly label: string;
      readonly description?: string;
      readonly allowNew?: boolean;
    };

export type CommandPath = {
  readonly tokens: readonly CommandToken[];
  readonly minimumTokens?: number;
  readonly description?: string;
};

const descriptions = {
  state: "Read the committed window-manager state.",
  windows: "List observed windows and their workspace membership.",
  displays: "List connected displays and their geometry.",
  workspaces: "List workspaces and their window membership.",
  reconcile: "Observe the desktop and run layout policy until it settles.",
  pause: "Pause automatic window-manager mutations.",
  resume: "Resume automatic window management and reconcile the desktop.",
  "validate-config": "Validate the active window-manager configuration.",
  "observe-window": "Read one committed window observation.",
  "focus-window": "Focus the specified window.",
  "move-window": "Move the specified window to global display coordinates.",
  "resize-window": "Resize the specified window to the requested dimensions.",
  float: "Exclude the specified window from tiling while retaining its workspace.",
  tile: "Return the specified window to workspace tiling.",
  manage: "Allow the window manager to manage the specified window.",
  unmanage: "Remove the specified window from window-manager control.",
  window: "Operate on a window.",
  workspace: "Operate on a workspace.",
  focus: "Change focus without rearranging the layout.",
  move: "Move the focused window or workspace.",
  left: "Use the neighbor or display edge to the left.",
  right: "Use the neighbor or display edge to the right.",
  up: "Use the neighbor or display edge above.",
  down: "Use the neighbor or display edge below.",
  "debug-frame": "Request an explicit, verified geometry write.",
  set: "Set the window position and size.",
  "probe-limits": "Reversibly measure the specified window's dimension limits.",
  "--toggle": "Switch between paused and running states.",
  next: "Use the next connected display.",
  "move-display": "Move a workspace onto the specified display.",
  mode: "Set the workspace layout mode.",
  bsp: "Tile windows using binary space partitions.",
  floating: "Leave workspace windows outside automatic tiling.",
  retile: "Retile a workspace, or the focused workspace when omitted.",
  "reload-config": "Reload configuration; use delta mode unless another mode is given.",
  delta: "Merge supplied configuration fields into the current configuration.",
  full: "Replace configuration-derived settings with the supplied configuration.",
  service: "Control the window-manager service.",
  start: "Start the window manager and manage the current desktop.",
  stop: "Stop the window manager and restore its parked windows.",
  restart: "Stop and then start the window manager.",
  install: "Install the local window-manager service.",
  status: "Report the local window-manager service status.",
  uninstall: "Uninstall the local window-manager service.",
} as const;

const literal = (
  value: keyof typeof descriptions,
  description: string = descriptions[value],
): CommandToken => ({ kind: "literal", value, description });
const slot = (
  kind: Extract<CommandToken, { kind: "slot" }>["slot"],
  label: string,
  allowNew = false,
): CommandToken => {
  const token = {
    kind: "slot" as const,
    slot: kind,
    label,
    description:
      kind === "window"
        ? "The window ID, or its name in a scenario."
        : kind === "workspace"
          ? "The name of a workspace."
          : kind === "display"
            ? "The stable ID of a display."
            : kind === "coordinate"
              ? `${label} in global display coordinates; negative values are allowed.`
              : `${label} in display-coordinate units; must be positive.`,
  };
  return allowNew ? { ...token, allowNew: true } : token;
};
const windowSlot = slot("window", "Window");
const displaySlot = slot("display", "Display");
const workspaceSlot = slot("workspace", "Workspace");
const newWorkspaceSlot = slot("workspace", "Workspace", true);
const xCoordinate = slot("coordinate", "X coordinate");
const yCoordinate = slot("coordinate", "Y coordinate");
const width = slot("dimension", "Width");
const height = slot("dimension", "Height");

/** Declarative CLI paths used by guided clients. Parsing remains authoritative. */
export const commandPaths: readonly CommandPath[] = [
  ...(
    [
      "state",
      "windows",
      "displays",
      "workspaces",
      "reconcile",
      "pause",
      "resume",
      "validate-config",
    ] as const
  ).map((verb) => ({ tokens: [literal(verb)], description: descriptions[verb] })),
  ...(["observe-window", "focus-window", "float", "tile", "manage", "unmanage"] as const).map(
    (verb) => ({
      tokens: [literal(verb), windowSlot],
      description: descriptions[verb],
    }),
  ),
  {
    tokens: [literal("move-window"), windowSlot, xCoordinate, yCoordinate],
    description: descriptions["move-window"],
  },
  {
    tokens: [literal("resize-window"), windowSlot, width, height],
    description: descriptions["resize-window"],
  },
  {
    description: descriptions["debug-frame"],
    tokens: [
      literal("debug-frame"),
      literal("set"),
      windowSlot,
      xCoordinate,
      yCoordinate,
      width,
      height,
    ],
  },
  {
    tokens: [literal("window"), literal("probe-limits"), windowSlot],
    description: descriptions["probe-limits"],
  },
  ...(["focus", "move"] as const).flatMap((action) =>
    DIRECTIONS.map((direction) => ({
      tokens: [literal("window"), literal(action), literal(direction)],
      description:
        action === "focus"
          ? `Focus the window ${FOCUS_RELATIONS[direction]} the focused window.`
          : `Move the focused window ${direction}. At the display’s edge, expand it along that edge.`,
    })),
  ),
  {
    tokens: [literal("window"), literal("move"), literal("workspace"), newWorkspaceSlot],
    description: "Move the focused window to a workspace and follow it.",
  },
  {
    tokens: [literal("workspace"), literal("focus"), newWorkspaceSlot],
    description: "Reveal and focus a workspace.",
  },
  {
    tokens: [literal("workspace"), literal("pause"), literal("--toggle")],
    description: "Toggle whether the window manager is paused.",
  },
  {
    tokens: [
      literal("workspace"),
      literal("move-window", "Move a window to another workspace."),
      newWorkspaceSlot,
    ],
    description: "Move the focused window to a workspace and follow it.",
  },
  {
    tokens: [
      literal("workspace"),
      literal("move-window", "Move a window to another workspace."),
      windowSlot,
      newWorkspaceSlot,
    ],
    description: "Move the specified window to a workspace.",
  },
  {
    tokens: [literal("workspace"), literal("move"), literal("next")],
    description: "Move the focused workspace to the next connected display.",
  },
  {
    tokens: [literal("workspace"), literal("move-display"), newWorkspaceSlot, displaySlot],
    description: descriptions["move-display"],
  },
  ...(["bsp", "floating"] as const).map((mode) => ({
    tokens: [literal("workspace"), literal("mode"), workspaceSlot, literal(mode)],
    description: descriptions["mode"],
  })),
  {
    tokens: [literal("retile"), workspaceSlot],
    minimumTokens: 1,
    description: descriptions["retile"],
  },
  {
    tokens: [literal("reload-config"), literal("delta")],
    minimumTokens: 1,
    description: descriptions["delta"],
  },
  {
    tokens: [literal("reload-config"), literal("full")],
    minimumTokens: 1,
    description: descriptions["full"],
  },
];

/** Data-only descriptors also serve host and simulated service commands. */
export const serviceCommandPaths: readonly CommandPath[] = (
  ["install", "start", "stop", "restart", "status", "uninstall"] as const
).map((action) => ({
  tokens: [literal("service"), literal(action)],
  description: descriptions[action],
}));

export function formatCommandHelp(paths: readonly CommandPath[] = commandPaths): string {
  return paths
    .map((path) => {
      const syntax = path.tokens
        .map((token, index) => {
          const value =
            token.kind === "literal"
              ? token.value
              : `<${token.label.toLowerCase().replaceAll(" ", "-")}>`;
          return index >= (path.minimumTokens ?? path.tokens.length) ? `[${value}]` : value;
        })
        .join(" ");
      return `  ${syntax.padEnd(54)} ${path.description ?? ""}`;
    })
    .join("\n");
}

export interface DescribedCommandToken {
  readonly value: string;
  readonly description: string;
}

export function describeCommandTokens(
  text: string,
  paths: readonly CommandPath[] = commandPaths,
): readonly DescribedCommandToken[] {
  const words = tokenizeCommandText(text);
  const prefixed = words[0] === "wm";
  if (prefixed) words.shift();
  const matches = paths.filter(
    (path) =>
      words.length <= path.tokens.length &&
      words.every((word, index) => {
        const token = path.tokens[index]!;
        return token.kind === "slot" || token.value === word;
      }),
  );
  const path =
    matches.find(
      (candidate) => words.length >= (candidate.minimumTokens ?? candidate.tokens.length),
    ) ?? matches[0];
  const described = words.map((value, index) => ({
    value: /\s|["'\\]/u.test(value) ? quoteCommandToken(value) : value,
    description:
      path?.tokens[index]?.description ?? path?.description ?? "A window-manager command token.",
  }));
  return prefixed
    ? [{ value: "wm", description: "Invoke the Paneform window manager." }, ...described]
    : described;
}

const directionOf = (value: string): Direction | null => {
  switch (value) {
    case "left":
    case "right":
    case "up":
    case "down":
      return value;
    default:
      return null;
  }
};

const finiteNumber = (value: string): number | null => {
  const number = Number(value);
  return value.length > 0 && Number.isFinite(number) ? number : null;
};

const hasOnlyFlags = (
  flags: Record<string, string | boolean>,
  allowed: readonly string[],
): boolean => Object.keys(flags).every((flag) => allowed.includes(flag));

/** Maps command words onto an engine command without applying layout policy. */
export function buildCommand(
  verb: string,
  rest: string[],
  flags: Record<string, string | boolean> = {},
): Command | null {
  const [a = "", b = "", c = "", d = ""] = rest;
  if (!hasOnlyFlags(flags, verb === "workspace" && a === "pause" ? ["toggle"] : [])) return null;

  switch (verb) {
    case "state":
      return rest.length === 0 ? { type: "getState" } : null;
    case "windows":
      return rest.length === 0 ? { type: "getWindows" } : null;
    case "observe-window":
      return rest.length === 1 && a ? { type: "getWindow", windowId: a } : null;
    case "displays":
      return rest.length === 0 ? { type: "getDisplays" } : null;
    case "workspaces":
      return rest.length === 0 ? { type: "getWorkspaces" } : null;
    case "focus-window":
      return rest.length === 1 && a ? { type: "focusWindow", windowId: a } : null;
    case "move-window": {
      if (rest.length !== 3 || !a) return null;
      const x = finiteNumber(b);
      const y = finiteNumber(c);
      return x === null || y === null ? null : { type: "moveWindow", windowId: a, point: { x, y } };
    }
    case "resize-window": {
      if (rest.length !== 3 || !a) return null;
      const width = finiteNumber(b);
      const height = finiteNumber(c);
      return width === null || height === null
        ? null
        : { type: "resizeWindow", windowId: a, size: { width, height } };
    }
    case "debug-frame": {
      if (a !== "set" || !b || rest.length !== 6) return null;
      const x = finiteNumber(rest[2] ?? "");
      const y = finiteNumber(rest[3] ?? "");
      const width = finiteNumber(rest[4] ?? "");
      const height = finiteNumber(rest[5] ?? "");
      if (x === null || y === null || width === null || height === null) return null;
      return width > 0 && height > 0
        ? { type: "setWindowFrame", windowId: b, frame: { x, y, width, height } }
        : null;
    }
    case "float":
      return rest.length === 1 && a ? { type: "floatWindow", windowId: a } : null;
    case "tile":
      return rest.length === 1 && a ? { type: "tileWindow", windowId: a } : null;
    case "manage":
      return rest.length === 1 && a ? { type: "manageWindow", windowId: a } : null;
    case "unmanage":
      return rest.length === 1 && a ? { type: "unmanageWindow", windowId: a } : null;
    case "window": {
      if (a === "probe-limits")
        return rest.length === 2 && b ? { type: "probeWindowLimits", windowId: b } : null;
      if (a === "move" && b === "workspace")
        return rest.length === 3 && c
          ? { type: "moveFocusedWindowToWorkspace", workspace: c }
          : null;
      if (rest.length !== 2) return null;
      const direction = directionOf(b);
      if (direction === null) return null;
      if (a === "focus") return { type: "focusDirection", direction };
      if (a === "move") return { type: "moveDirection", direction };
      return null;
    }
    case "workspace":
      if (a === "focus") return rest.length === 2 && b ? { type: "focusWorkspace", name: b } : null;
      if (a === "pause")
        return rest.length === 1 && flags["toggle"] === true ? { type: "togglePause" } : null;
      if (a === "move-window") {
        if (rest.length === 2 && b) return { type: "moveFocusedWindowToWorkspace", workspace: b };
        if (rest.length === 3 && b && c)
          return { type: "moveWindowToWorkspace", windowId: b, workspace: c };
        return null;
      }
      if (a === "move")
        return rest.length === 2 && b === "next"
          ? { type: "moveFocusedWorkspaceToNextDisplay" }
          : null;
      if (a === "move-display")
        return rest.length === 3 && b && c
          ? { type: "moveWorkspaceToDisplay", workspace: b, displayId: c }
          : null;
      if (a === "mode")
        return rest.length === 3 && b && (c === "bsp" || c === "floating")
          ? { type: "setWorkspaceMode", workspace: b, mode: c }
          : null;
      return null;
    case "retile":
      if (rest.length > 1) return null;
      return a ? { type: "retile", workspace: a } : { type: "retile" };
    case "reconcile":
      return rest.length === 0 ? { type: "reconcile" } : null;
    case "pause":
      return rest.length === 0 ? { type: "pause" } : null;
    case "resume":
      return rest.length === 0 ? { type: "resume" } : null;
    case "validate-config":
      return rest.length === 0 ? { type: "validateConfig" } : null;
    case "reload-config":
      if (rest.length === 0) return { type: "reloadConfig" };
      return rest.length === 1 && (a === "delta" || a === "full")
        ? { type: "reloadConfig", mode: a }
        : null;
    default:
      return null;
  }
}

export function buildKeybindCommand(action: string): Command | null {
  let words: string[];
  try {
    words = tokenizeCommandText(action);
  } catch {
    return null;
  }
  return buildWords(words);
}

/** Parses one command as data. This never invokes or emulates a shell. */
export function parseCommandText(text: string): Command {
  const words = tokenizeCommandText(text);
  if (words[0] === "wm") words.shift();
  const command = buildWords(words);
  if (command === null) throw new Error(`Invalid wm command: ${text}`);
  return command;
}

function buildWords(words: string[]): Command | null {
  const verb = words.shift();
  if (!verb) return null;
  const flags: Record<string, boolean> = Object.create(null);
  const positional = words.filter((word) => {
    if (!word.startsWith("--")) return true;
    flags[word.slice(2)] = true;
    return false;
  });
  return buildCommand(verb, positional, flags);
}

/** Quotes one token so tokenizeCommandText returns the original value exactly. */
export function quoteCommandToken(value: string): string {
  return `"${value.replace(/[\\"]/gu, "\\$&")}"`;
}

export function tokenizeCommandText(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let started = false;

  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (quote !== null) {
      if (character === quote) quote = null;
      else if (character === "\\") {
        if (++index >= text.length) throw new Error("Invalid wm command: trailing backslash");
        word += text[index]!;
      } else word += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (character === "\\") {
      if (++index >= text.length) throw new Error("Invalid wm command: trailing backslash");
      word += text[index]!;
      started = true;
    } else if (/\s/.test(character)) {
      if (character === "\n" || character === "\r")
        throw new Error("Invalid wm command: command chaining is not allowed");
      if (started) words.push(word);
      word = "";
      started = false;
    } else if (/[;|&<>`$(){}[\]*?~!#]/.test(character)) {
      throw new Error(`Invalid wm command: unquoted shell character ${character}`);
    } else {
      word += character;
      started = true;
    }
  }
  if (quote !== null) throw new Error("Invalid wm command: unterminated quote");
  if (started) words.push(word);
  return words;
}
