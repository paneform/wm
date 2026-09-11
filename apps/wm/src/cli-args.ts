import {
  buildCommand,
  buildKeybindCommand,
  commandPaths,
  formatCommandHelp,
  serviceCommandPaths,
  type Command,
} from "@paneform/layout";

export { buildCommand, buildKeybindCommand };

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

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = Object.create(null);
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
  const commandFlags = { ...flags };
  for (const flag of ["port", "url", "sidecar", "observe-only", "open-settings"])
    delete commandFlags[flag];
  const command =
    verb === undefined || help || serve || localCommand !== null
      ? null
      : buildCommand(verb, positional.slice(1), commandFlags);
  return { command, localCommand, positional, flags, help, serve };
}

/** Contextual help uses the same descriptions as guided command clients. */
export function helpFor(words: readonly string[]): string {
  if (words.length === 0) return USAGE;
  const paths = [...commandPaths, ...serviceCommandPaths].filter(
    (path) =>
      words.length <= path.tokens.length &&
      words.every((word, index) => {
        const token = path.tokens[index]!;
        return token.kind === "slot" || token.value === word;
      }),
  );
  if (paths.length === 0) return USAGE;
  const argumentsHelp = new Map<string, string>();
  for (const path of paths)
    for (const token of path.tokens) {
      if (token.kind === "slot" && token.description)
        argumentsHelp.set(token.label, token.description);
    }
  return `wm ${words.join(" ")}\n\n${formatCommandHelp(paths)}${argumentsHelp.size === 0 ? "" : `\n\nArguments:\n${[...argumentsHelp].map(([label, description]) => `  ${label}: ${description}`).join("\n")}`}`;
}

export const USAGE = `wm — macOS window manager

Client:
  wm <command> [args...]     Execute a command against the daemon over WebSocket
Commands:
${formatCommandHelp(commandPaths)}
Local (no daemon required):
  wm doctor                  Report macOS permissions as JSON; read-only
  wm permissions request     Trigger TCC prompts via the sidecar, then report status
                             (--open-settings deep links System Settings panes)
Service:
${formatCommandHelp(serviceCommandPaths)}
Daemon:
  wm serve [--port N] [--observe-only] [--sidecar PATH]
Flags:
  --port N        Daemon WebSocket port (default from config or 17832)
  --sidecar PATH  Explicit wm-sidecar executable for local commands
  --observe-only  Start paused: observe/query state without platform mutations
  --url WS-URL    Daemon WebSocket URL for client commands
  --help          Show this help`;
