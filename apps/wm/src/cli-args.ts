import {
  buildCommand,
  buildKeybindCommand,
  commandPaths,
  formatCommandHelp,
  serviceCommandPaths,
  parseCommandInvocation,
  commandHelpPaths,
  isEngineCommand,
  type CommandParseError,
  type ServiceAction,
  type Command,
} from "@paneform/layout";

export { buildCommand, buildKeybindCommand };

/** Commands executed locally (sidecar spawn) instead of over the daemon WebSocket. */
export type LocalCommand = "permissions" | "permissions-request";

export interface ParsedArgs {
  command: Command | null;
  localCommand: LocalCommand | null;
  positional: string[];
  flags: Record<string, string | boolean>;
  help: boolean;
  serve: boolean;
  service: ServiceAction | null;
  error: CommandParseError | null;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const help = argv.includes("--help") || argv.includes("-h");
  const positional = argv.filter((token) => token !== "--help" && token !== "-h");
  const result = help ? null : parseCommandInvocation(argv);
  const parsed = result?.ok ? result.value.command : null;
  return {
    command: parsed && isEngineCommand(parsed) ? parsed : null,
    localCommand:
      parsed?.type === "permissions"
        ? parsed.action === "request"
          ? "permissions-request"
          : "permissions"
        : null,
    positional,
    flags: result?.ok ? { ...result.value.options } : {},
    help,
    serve: parsed?.type === "serve",
    service: parsed?.type === "service" ? parsed.action : null,
    error: result && !result.ok ? result.error : null,
  };
}

/** Contextual help uses the same descriptions as guided command clients. */
export function helpFor(words: readonly string[]): string {
  if (words.length === 0) return USAGE;
  const paths = commandHelpPaths(words);
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
  wm permissions             Report macOS permissions as JSON; read-only
  wm permissions request     Trigger TCC prompts via the sidecar, then report status
                             (--open-settings deep links System Settings panes)
Service:
${formatCommandHelp(serviceCommandPaths)}
Daemon:
  wm serve [--port N] [--observe-only] [--sidecar PATH]
Flags:
  --verbose       Show the full command response and diagnostic details
  --port N        Daemon WebSocket port (default from config or 17832)
  --sidecar PATH  Explicit wm-sidecar executable for local commands
  --observe-only  Start paused: observe/query state without platform mutations
  --url WS-URL    Daemon WebSocket URL for client commands
  --help          Show this help`;
