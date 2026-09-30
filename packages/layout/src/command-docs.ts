import {
  buildCommand,
  commandPaths,
  serviceCommandPaths,
  type CommandPath,
} from "./command-syntax.js";
import type { Command, CommandErrorCode } from "./commands.js";

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
  moveFocusedWindowToWorkspace: { slug: "windows/move-to-workspace", title: "Move to workspace" },
  moveWindowToWorkspace: { slug: "windows/move-to-workspace", title: "Move to workspace" },
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
  moveFocusedWindowToWorkspace: [
    { code: "paused", meaning: "The manager is paused.", action: "Run wm resume, then retry." },
  ],
  moveWindowToWorkspace: [
    {
      code: "window_not_found",
      meaning: "The specified window ID is not live.",
      action: "Find a current ID with wm windows and retry.",
    },
  ],
};

const samples = {
  window: "w1",
  workspace: "writing",
  display: "display:main",
  coordinate: "100",
  dimension: "600",
} as const;

function describePath(path: CommandPath) {
  const words = path.tokens.map((token) =>
    token.kind === "literal" ? token.value : samples[token.slot],
  );
  const flags = Object.fromEntries(
    words.filter((word) => word.startsWith("--")).map((word) => [word.slice(2), true]),
  );
  const args = words.slice(1).filter((word) => !word.startsWith("--"));
  const command = buildCommand(words[0]!, args, flags);
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
