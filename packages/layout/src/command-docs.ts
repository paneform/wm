import {
  parseCommandTokens,
  isEngineCommand,
  commandPaths,
  serviceCommandPaths,
  type CommandPath,
} from "./command-syntax.js";
import type { CommandErrorCode } from "./commands.js";
import { Command } from "./commands.js";
import {
  isLiteral,
  isRefinement,
  isTypeLiteral,
  type AST,
  type TypeLiteral,
} from "effect/SchemaAST";
import { isString } from "effect/Predicate";

export interface DocumentedError {
  code: CommandErrorCode;
  meaning: string;
  action: string;
}

export interface DocumentedCommand {
  slug: string;
  title: string;
  summary: string;
  domain: string;
  forms: {
    syntax: string;
    description: string;
    type: Command["type"] | null;
    example: string | null;
  }[];
  errors: DocumentedError[];
}

/** CLI-phrased option notes; a few flags read differently per command. */
const optionNotes = new Map<string, string>([
  ["window", "the window the command should target. If omitted, the focused window is used"],
  ["workspace", "the workspace the command should target. If omitted, the focused workspace is used"],
  ["no-follow", "keeps the current workspace in view instead of following the assigned window"],
  ["pid", "inspects a raw application window by process ID instead of a window ID"],
]);
const optionNotesBySlug = new Map<string, Map<string, string>>([
  [
    "windows/float",
    new Map([["toggle", "toggles the targeted window between floating and tiling behavior"]]),
  ],
  ["system/pause", new Map([["toggle", "toggles the paused state instead of pausing"]])],
  ["windows/focus", new Map([["window", "the window the command should target"]])],
]);

/** CLI/scenario/keybind phrasing of an option flag on a command page. */
export const optionSummary = (slug: string, flag: string): string => {
  const note = optionNotesBySlug.get(slug)?.get(flag) ?? optionNotes.get(flag) ?? "";
  return note === "" ? "" : `${note}.`;
};

export interface DocumentedField {
  readonly name: string;
  readonly required: boolean;
  /** Tooltip text: Required/Optional plus the field's meaning. */
  readonly summary: string;
}

const fieldNotes = new Map<string, string>([
  ["type", "selects the command to execute"],
  ["windowId", "omitted, the focused window is resolved at execution"],
  ["toggle", "resolved against committed state at execution; toggles float and tile"],
  ["follow", "defaults to true: focus follows the assigned window"],
  ["pid", "inspect by process ID instead; use either pid or windowId"],
  ["id", "the transaction ID from a command response"],
  ["name", "the workspace to reveal; a new name is created on first use"],
  ["direction", "one of left, right, up or down"],
  ["point", "global x/y coordinates"],
  ["size", "width and height"],
  ["displayId", "a connected display ID from wm display list"],
  ["mode", "bsp or floating"],
  ["topics", "defaults to every topic"],
]);

/** A few fields mean different things per command; these override fieldNotes. */
const notesByType = new Map<string, Map<string, string>>([
  ["moveWindowToWorkspace", new Map([["workspace", "the destination workspace"]])],
  ["moveWorkspaceToDisplay", new Map([["workspace", "omitted, the focused workspace moves"]])],
  ["setWorkspaceMode", new Map([["workspace", "omitted, the focused workspace changes mode"]])],
  ["retile", new Map([["workspace", "omitted, the focused workspace is retiled"]])],
  ["reloadConfig", new Map([["mode", "delta or full; omitted, delta"]])],
]);

let fieldsCache: ReadonlyMap<string, readonly DocumentedField[]> | null = null;

function typeLiteralOf(ast: AST): TypeLiteral | null {
  if (isRefinement(ast)) return typeLiteralOf(ast.from);
  return isTypeLiteral(ast) ? ast : null;
}

const literalNameOf = (ast: AST): string | null =>
  isLiteral(ast) && isString(ast.literal) ? ast.literal : null;

/** Payload fields with required/optional derived from the wire schema itself. */
export function documentedFields(type: string): readonly DocumentedField[] {
  if (fieldsCache === null) {
    const map = new Map<string, readonly DocumentedField[]>();
    const union = Command.ast;
    for (const member of union._tag === "Union" ? union.types : [union]) {
      const literal = typeLiteralOf(member);
      if (literal === null) continue;
      const namePs = literal.propertySignatures.find((ps) => ps.name === "type");
      const name = namePs === undefined ? null : literalNameOf(namePs.type);
      if (name === null) continue;
      const typeNotes = notesByType.get(name) ?? new Map<string, string>();
      map.set(
        name,
        literal.propertySignatures.map((ps) => {
          const fieldName = String(ps.name);
          const note = typeNotes.get(fieldName) ?? fieldNotes.get(fieldName) ?? "";
          return {
            name: fieldName,
            required: !ps.isOptional,
            summary: `${ps.isOptional ? "Optional" : "Required"}${note === "" ? "." : ` — ${note}.`}`,
          };
        }),
      );
    }
    fieldsCache = map;
  }
  return fieldsCache.get(type) ?? [];
}

/** Documentation joins the CLI grammar to the command builder. Syntax and descriptions
 * stay in command-syntax.ts; these overrides only provide stable page identities. */
const pages: Partial<Record<Command["type"], { slug: string; title: string; summary?: string }>> = {
  moveDirection: {
    slug: "windows/move-directional",
    title: "Move window directionally",
    summary:
      "Swap the focused window with a neighbor in a direction, or expand along an unoccupied display edge.",
  },
  focusDirection: {
    slug: "windows/focus-directional",
    title: "Focus a neighboring window",
    summary: "Focus a neighboring window in a direction.",
  },
  moveWindowToWorkspace: { slug: "windows/assign", title: "Assign window to workspace" },
  getWindow: { slug: "windows/observe", title: "Observe window" },
  getWindows: { slug: "windows/list", title: "List windows" },
  getWorkspaces: { slug: "workspaces/list", title: "List workspaces" },
  getDisplays: { slug: "displays/list", title: "List displays" },
  focusWindow: { slug: "windows/focus", title: "Focus window" },
  moveWindow: { slug: "windows/move-position", title: "Move window to position" },
  resizeWindow: { slug: "windows/resize", title: "Resize window" },
  floatWindow: { slug: "windows/float", title: "Float window" },
  tileWindow: { slug: "windows/tile", title: "Tile window" },
  manageWindow: { slug: "windows/manage", title: "Manage window" },
  unmanageWindow: { slug: "windows/unmanage", title: "Unmanage window" },
  reloadConfig: { slug: "config/reload", title: "Reload configuration" },
  validateConfig: { slug: "config/validate", title: "Validate configuration" },
  togglePause: { slug: "system/pause", title: "Pause" },
  focusWorkspace: { slug: "workspaces/focus", title: "Focus workspace" },
  moveWorkspaceToDisplay: {
    slug: "workspaces/move-to-display",
    title: "Move workspace to display",
  },
  moveFocusedWorkspaceToNextDisplay: {
    slug: "workspaces/move-to-next-display",
    title: "Move workspace to next display",
  },
  setWorkspaceMode: { slug: "workspaces/mode", title: "Set workspace mode" },
  retile: { slug: "workspaces/retile", title: "Retile workspace" },
};

const errorsByType: Partial<Record<Command["type"], DocumentedError[]>> = {
  moveDirection: [
    { code: "paused", meaning: "The manager is paused.", action: "Run wm resume, then retry." },
  ],
  moveWindowToWorkspace: [
    {
      code: "window_not_found",
      meaning: "The specified window ID is not live.",
      action: "Find a current ID with wm window list and retry.",
    },
  ],
};

const samples = {
  window: "w1",
  workspace: "2",
  display: "display:main",
  coordinate: "100",
  dimension: "600",
} as const;

function describePath(path: CommandPath) {
  const words = path.tokens.map((token) =>
    token.kind === "literal" ? token.value : samples[token.slot],
  );
  const result = parseCommandTokens(words);
  const command = result.ok && isEngineCommand(result.value) ? result.value : null;
  const required = path.minimumTokens ?? words.length;
  const syntax = path.tokens
    .map((token, index) => {
      const value =
        token.kind === "literal"
          ? token.value
          : `<${token.label.toLowerCase().replaceAll(" ", "-")}>`;
      return index < required ? value : `[${value}]`;
    })
    .join(" ");
  return {
    syntax: `wm ${syntax}`,
    description: path.description ?? "",
    type: command?.type ?? null,
    example: command ? `wm ${words.filter((word, index) => index < required).join(" ")}` : null,
  };
}

function pageFor(path: CommandPath, type: string | null) {
  if (path.tokens[0]?.kind === "literal" && path.tokens[0].value === "service") {
    const action = path.tokens[1];
    if (action?.kind === "literal")
      return { slug: `service/${action.value}`, title: `Service ${action.value}` };
  }
  const configured = Object.entries(pages).find(([key]) => key === type)?.[1];
  if (configured) return configured;
  const first = path.tokens[0];
  const name = first?.kind === "literal" ? first.value : "command";
  const domain =
    [
      "observe-window",
      "focus-window",
      "move-window",
      "resize-window",
      "float",
      "tile",
      "manage",
      "unmanage",
    ].includes(name) || name === "window"
      ? "windows"
      : "system";
  const slug = path.tokens
    .map((token) => (token.kind === "literal" ? token.value : ""))
    .filter(Boolean)
    .join("-");
  return {
    slug: `${domain}/${slug}`,
    title: slug.replaceAll("-", " ").replace(/^./, (letter) => letter.toUpperCase()),
  };
}

export function buildCommandDocs(
  paths: readonly CommandPath[] = [...commandPaths, ...serviceCommandPaths],
): DocumentedCommand[] {
  const grouped = new Map<string, DocumentedCommand>();
  for (const path of paths) {
    const form = describePath(path);
    const page = pageFor(path, form.type);
    const { slug, title } = page;
    const existing = grouped.get(slug);
    if (existing) existing.forms.push(form);
    else
      grouped.set(slug, {
        slug,
        title,
        summary: "summary" in page ? (page.summary ?? form.description) : form.description,
        domain: slug.split("/")[0]!,
        forms: [form],
        errors: [],
      });
    const entry = grouped.get(slug)!;
    const known = Object.entries(errorsByType).find(([key]) => key === form.type)?.[1] ?? [];
    for (const issue of known)
      if (!entry.errors.some((existing) => existing.code === issue.code)) entry.errors.push(issue);
  }
  return [...grouped.values()];
}

export const commandDocs = buildCommandDocs();
