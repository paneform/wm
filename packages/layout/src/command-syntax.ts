import type { Command } from "./commands.js";

export type Result<Value, Error> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: Error };
export interface CommandParseError {
  readonly code: "invalid_command" | "invalid_option" | "invalid_value" | "invalid_text";
  readonly message: string;
  readonly help: string;
}
export const SERVICE_ACTIONS = [
  "install",
  "start",
  "stop",
  "restart",
  "status",
  "uninstall",
] as const;
export type ServiceAction = (typeof SERVICE_ACTIONS)[number];
export type ParsedCommand =
  | Command
  | { readonly type: "service"; readonly action: ServiceAction }
  | { readonly type: "permissions"; readonly action: "status" | "request" }
  | { readonly type: "serve" };
export const isEngineCommand = (command: ParsedCommand): command is Command =>
  command.type !== "service" && command.type !== "permissions" && command.type !== "serve";

export type CommandToken =
  | { readonly kind: "literal"; readonly value: string; readonly description?: string }
  | {
      readonly kind: "slot";
      readonly slot: "window" | "display" | "workspace" | "coordinate" | "dimension";
      readonly label: string;
      readonly description?: string;
      readonly allowNew?: boolean;
    };
export interface CommandPath {
  readonly tokens: readonly CommandToken[];
  readonly minimumTokens?: number;
  readonly description?: string;
}
type Options = Readonly<Record<string, string | boolean>>;
interface CommandSpec extends CommandPath {
  readonly requiredOptions?: readonly string[];
  readonly exclusiveOptions?: readonly string[];
  readonly options?: Readonly<Record<string, CommandToken | true>>;
  readonly build: (values: readonly string[], options: Options) => ParsedCommand;
}
const literal = (value: string): CommandToken => ({
  kind: "literal",
  value,
  description: `Use ${value}.`,
});
const slot = (
  kind: Extract<CommandToken, { kind: "slot" }>["slot"],
  label: string,
  allowNew = false,
): CommandToken => ({
  kind: "slot",
  slot: kind,
  label,
  allowNew,
  description:
    kind === "workspace"
      ? "The name of a workspace."
      : kind === "window"
        ? "The window ID, or its name in a scenario."
        : `The ${label.toLowerCase()}.`,
});
const windowSlot = slot("window", "Window");
const workspaceSlot = slot("workspace", "Workspace", true);
const existingWorkspaceSlot = slot("workspace", "Workspace");
const displaySlot = slot("display", "Display");
const coordinate = (label: string) => slot("coordinate", label);
const dimension = (label: string) => slot("dimension", label);
const target = (options: Options) =>
  options["window"] === undefined ? {} : { windowId: String(options["window"]) };
const workspaceTarget = (options: Options) =>
  options["workspace"] === undefined ? {} : { workspace: String(options["workspace"]) };
const spec = (
  words: string,
  description: string,
  build: CommandSpec["build"],
  args: readonly CommandToken[] = [],
  options: NonNullable<CommandSpec["options"]> = {},
): CommandSpec => ({
  tokens: [...words.split(" ").map((value) => ({ ...literal(value), description })), ...args],
  description,
  build,
  options,
});
const windowOptions = { window: windowSlot };
const workspaceOptions = { workspace: workspaceSlot };
const directions = ["left", "right", "up", "down"] as const;
const windowActions = ["tile", "manage", "unmanage"] as const;
const windowTypes = {
  tile: "tileWindow",
  manage: "manageWindow",
  unmanage: "unmanageWindow",
} as const;

/** One specification supplies parsing, help, docs and guided command clients. */
const engineSpecs: readonly CommandSpec[] = [
  spec("state", "Read the committed window-manager state.", () => ({ type: "getState" })),
  spec("window list", "List observed windows and their workspace membership.", () => ({
    type: "getWindows",
  })),
  spec("display list", "List connected displays and their geometry.", () => ({
    type: "getDisplays",
  })),
  spec("workspace list", "List workspaces and their window membership.", () => ({
    type: "getWorkspaces",
  })),
  spec("reconcile", "Observe the desktop and settle its layout.", () => ({ type: "reconcile" })),
  spec(
    "pause",
    "Pause automatic window management; --toggle toggles it.",
    (_, options) => ({ type: options["toggle"] === true ? "togglePause" : "pause" }),
    [],
    { toggle: true },
  ),
  spec("resume", "Resume automatic window management.", () => ({ type: "resume" })),
  spec("config validate", "Validate the active configuration.", () => ({ type: "validateConfig" })),
  spec("config reload", "Reload configuration in delta mode.", () => ({
    type: "reloadConfig",
    mode: "delta",
  })),
  ...(["delta", "full"] as const).map((mode) =>
    spec(
      `config reload ${mode}`,
      `${mode === "delta" ? "Merge" : "Replace"} configuration settings.`,
      () => ({ type: "reloadConfig", mode }),
    ),
  ),
  spec(
    "window float",
    "Float the selected or focused window; --toggle switches float and tile.",
    (_, options) =>
      options["toggle"] === true
        ? { type: "floatWindow", toggle: true, ...target(options) }
        : { type: "floatWindow", ...target(options) },
    [],
    { ...windowOptions, toggle: true },
  ),
  ...windowActions.map((action) =>
    spec(
      `window ${action}`,
      `${action[0]!.toUpperCase()}${action.slice(1)} the selected or focused window.`,
      (_, options) => ({ type: windowTypes[action], ...target(options) }),
      [],
      windowOptions,
    ),
  ),
  {
    ...spec(
      "window observe",
      "Read live window facts and platform diagnostics; --pid inspects raw application windows on macOS.",
      (_, options) =>
        options["pid"] === undefined
          ? { type: "getWindow", ...target(options) }
          : { type: "getWindow", pid: Number(options["pid"]) },
      [],
      { ...windowOptions, pid: dimension("Process ID") },
    ),
    exclusiveOptions: ["window", "pid"],
  },
  {
    ...spec(
      "window focus",
      "Focus the specified window and the workspace that contains it.",
      (_, options) => ({ type: "focusWindow", ...target(options) }),
      [],
      windowOptions,
    ),
    requiredOptions: ["window"],
  },
  ...directions.flatMap((direction) => [
    spec(`window focus ${direction}`, `Focus a neighboring window ${direction}.`, () => ({
      type: "focusDirection",
      direction,
    })),
    spec(
      `window move ${direction}`,
      `Move the focused window ${direction}; expand along a shared display edge.`,
      () => ({ type: "moveDirection", direction }),
    ),
  ]),
  spec(
    "window move position",
    "Move the selected or focused window to global coordinates.",
    (values, options) => ({
      type: "moveWindow",
      point: { x: Number(values[0]), y: Number(values[1]) },
      ...target(options),
    }),
    [coordinate("X coordinate"), coordinate("Y coordinate")],
    windowOptions,
  ),
  spec(
    "window resize",
    "Resize the selected or focused window.",
    (values, options) => ({
      type: "resizeWindow",
      size: { width: Number(values[0]), height: Number(values[1]) },
      ...target(options),
    }),
    [dimension("Width"), dimension("Height")],
    windowOptions,
  ),
  spec(
    "window assign",
    "Assign a window to a workspace and follow it, unless --no-follow is set.",
    (values, options) => ({
      type: "moveWindowToWorkspace",
      workspace: values[0]!,
      follow: options["no-follow"] !== true,
      ...target(options),
    }),
    [workspaceSlot],
    { ...windowOptions, "no-follow": true },
  ),
  spec(
    "workspace focus",
    "Reveal and focus a workspace.",
    (values) => ({ type: "focusWorkspace", name: values[0]! }),
    [workspaceSlot],
  ),
  spec("workspace move display next", "Move the focused workspace to the next display.", () => ({
    type: "moveFocusedWorkspaceToNextDisplay",
  })),
  spec(
    "workspace move display",
    "Move the selected or focused workspace to a display.",
    (values, options) => ({
      type: "moveWorkspaceToDisplay",
      displayId: values[0]!,
      ...workspaceTarget(options),
    }),
    [displaySlot],
    workspaceOptions,
  ),
  ...(["bsp", "floating"] as const).map((mode) =>
    spec(
      `workspace mode ${mode}`,
      "Set the selected or focused workspace layout mode.",
      (_, options) => ({ type: "setWorkspaceMode", mode, ...workspaceTarget(options) }),
      [],
      { workspace: existingWorkspaceSlot },
    ),
  ),
  spec(
    "workspace retile",
    "Retile the selected or focused workspace.",
    (_, options) => ({ type: "retile", ...workspaceTarget(options) }),
    [],
    { workspace: existingWorkspaceSlot },
  ),
];
const serviceDescriptions = {
  install: "Install the local window-manager service.",
  start: "Start the window manager and manage the current desktop.",
  stop: "Stop the window manager and restores all windows to visible positions.",
  restart: "Stop and then start the window manager.",
  status: "Report the local window-manager service status.",
  uninstall: "Uninstall the local window-manager service.",
};
const serviceSpecs = SERVICE_ACTIONS.map((action) =>
  spec(`service ${action}`, serviceDescriptions[action], () => ({ type: "service", action })),
);
const hostSpecs = [
  spec("permissions", "Report macOS permission readiness.", () => ({
    type: "permissions",
    action: "status",
  })),
  spec(
    "permissions request",
    "Request macOS permissions.",
    () => ({
      type: "permissions",
      action: "request",
    }),
    [],
    { "open-settings": true },
  ),
  spec("serve", "Start the window-manager daemon.", () => ({ type: "serve" }), [], {
    "observe-only": true,
  }),
];
const allSpecs = [...engineSpecs, ...serviceSpecs, ...hostSpecs];

function pathsFor(entry: CommandSpec): CommandPath[] {
  const options = Object.entries(entry.options ?? {});
  return options
    .reduce<CommandPath[]>(
      (paths, [name, value]) => [
        ...paths,
        ...paths.map((path) => ({
          ...path,
          tokens: [...path.tokens, literal(`--${name}`), ...(value === true ? [] : [value])],
        })),
      ],
      [{ tokens: entry.tokens, description: entry.description ?? "" }],
    )
    .filter((path) => {
      const names = path.tokens.flatMap((token) =>
        token.kind === "literal" && token.value.startsWith("--") ? [token.value.slice(2)] : [],
      );
      return (
        (entry.requiredOptions ?? []).every((name) => names.includes(name)) &&
        !conflictingOptions(entry, names)
      );
    });
}
const conflictingOptions = (entry: CommandSpec, names: readonly string[]) =>
  (entry.exclusiveOptions ?? []).filter((name) => names.includes(name)).length > 1;
export const commandPaths: readonly CommandPath[] = engineSpecs.flatMap(pathsFor);
export const serviceCommandPaths: readonly CommandPath[] = serviceSpecs.flatMap(pathsFor);
export const hostCommandPaths: readonly CommandPath[] = hostSpecs.flatMap(pathsFor);

const success = <Value>(value: Value): Result<Value, CommandParseError> => ({ ok: true, value });
const failure = (
  code: CommandParseError["code"],
  message: string,
): Result<never, CommandParseError> => ({
  ok: false,
  error: {
    code,
    message,
    help: formatCommandHelp([...commandPaths, ...serviceCommandPaths, ...hostCommandPaths]),
  },
});
export const formatCommandParseError = (error: CommandParseError): string =>
  `${error.message}\n\nUsage:\n${error.help}`;
function contextualFailure(
  result: Result<never, CommandParseError>,
  words: readonly string[],
): Result<never, CommandParseError> {
  if (result.ok) return result;
  const paths = [...commandPaths, ...serviceCommandPaths, ...hostCommandPaths];
  let relevant = paths;
  for (let count = 1; count <= words.length; count++) {
    const matched = paths.filter((path) =>
      words
        .slice(0, count)
        .every(
          (word, index) =>
            path.tokens[index]?.kind === "literal" && path.tokens[index].value === word,
        ),
    );
    if (matched.length === 0) break;
    relevant = matched;
  }
  return { ok: false, error: { ...result.error, help: formatCommandHelp(relevant) } };
}
const optionKinds = new Map<string, "value" | "boolean">([
  ...allSpecs.flatMap((entry) =>
    Object.entries(entry.options ?? {}).map(([name, value]): [string, "value" | "boolean"] => [
      name,
      value === true ? "boolean" : "value",
    ]),
  ),
  ["port", "value"],
  ["url", "value"],
  ["sidecar", "value"],
  ["verbose", "boolean"],
]);
const transportOptions = ["port", "url", "sidecar", "verbose"];
export interface CommandInvocation {
  readonly command: ParsedCommand;
  readonly options: Options;
  readonly tokens: readonly string[];
}
function canonicalTokens(entry: CommandSpec, words: readonly string[], options: Options): string[] {
  return [
    ...words,
    ...Object.entries(entry.options ?? {}).flatMap(([name, kind]) => {
      const value = options[name];
      if (value === undefined) return [];
      return kind === true ? [`--${name}`] : [`--${name}`, String(value)];
    }),
  ];
}

function splitOptions(
  tokens: readonly string[],
): Result<{ words: string[]; options: Record<string, string | boolean> }, CommandParseError> {
  const words: string[] = [];
  const options: Record<string, string | boolean> = Object.create(null);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (!token.startsWith("--")) {
      words.push(token);
      continue;
    }
    const [name = "", inline] = token.slice(2).split(/=(.*)/su);
    const kind = optionKinds.get(name);
    if (!kind) return failure("invalid_option", `--${name} is not an option recognized by wm.`);
    if (Object.hasOwn(options, name))
      return failure("invalid_option", `--${name} was supplied more than once.`);
    if (kind === "boolean") {
      if (inline !== undefined) return failure("invalid_option", `--${name} does not take a value`);
      options[name] = true;
    } else {
      const value = inline ?? tokens[++index];
      if (!value || value.startsWith("--"))
        return failure("invalid_option", `--${name} requires a value`);
      options[name] = value;
    }
  }
  return success({ words, options });
}

function matches(entry: CommandPath, words: readonly string[]): boolean {
  return (
    entry.tokens.length === words.length &&
    entry.tokens.every((token, index) => token.kind === "slot" || token.value === words[index])
  );
}
function validateValues(
  entry: CommandSpec,
  words: readonly string[],
): Result<readonly string[], CommandParseError> {
  const values: string[] = [];
  for (const [index, token] of entry.tokens.entries()) {
    if (token.kind === "literal") continue;
    const value = words[index]!;
    if (
      !value ||
      ((token.slot === "coordinate" || token.slot === "dimension") &&
        (!Number.isFinite(Number(value)) || (token.slot === "dimension" && Number(value) <= 0)))
    )
      return failure("invalid_value", `Invalid ${token.label.toLowerCase()}: ${value}`);
    values.push(value);
  }
  return success(values);
}
function allowedOptions(entry: CommandSpec, options: Options): Result<Options, CommandParseError> {
  if (conflictingOptions(entry, Object.keys(options)))
    return failure(
      "invalid_option",
      `Use only one of ${(entry.exclusiveOptions ?? []).map((name) => `--${name}`).join(", ")}`,
    );
  if (entry.options?.["pid"] !== undefined && options["pid"] !== undefined) {
    const pid = Number(options["pid"]);
    if (!Number.isInteger(pid) || pid < 1 || pid > 2147483647)
      return failure("invalid_value", "--pid requires a positive 32-bit process ID");
  }
  const missing = entry.requiredOptions?.find((name) => !Object.hasOwn(options, name));
  if (missing) return failure("invalid_option", `--${missing} is required for this command`);
  const allowed = [...Object.keys(entry.options ?? {}), ...transportOptions];
  const invalid = Object.keys(options).find((name) => !allowed.includes(name));
  return invalid
    ? failure("invalid_option", `--${invalid} is not valid for this command`)
    : success(options);
}
export function parseCommandInvocation(
  tokens: readonly string[],
): Result<CommandInvocation, CommandParseError> {
  const split = splitOptions(tokens[0] === "wm" ? tokens.slice(1) : tokens);
  if (!split.ok)
    return contextualFailure(
      split,
      tokens.filter((token) => !token.startsWith("--")),
    );
  const { words, options } = split.value;
  const entry = allSpecs.find((candidate) => matches(candidate, words));
  if (!entry) {
    const root = words[0];
    const known = allSpecs.some(
      (candidate) => candidate.tokens[0]?.kind === "literal" && candidate.tokens[0].value === root,
    );
    const message = !root
      ? "A command is required."
      : known
        ? `The arguments for ${words.join(" ")} are incomplete or not recognized by wm.`
        : `${root} is not a command recognized by wm.`;
    return contextualFailure(failure("invalid_command", message), words);
  }
  const validOptions = allowedOptions(entry, options);
  if (!validOptions.ok) return contextualFailure(validOptions, words);
  const values = validateValues(entry, words);
  return values.ok
    ? success({
        command: entry.build(values.value, options),
        options,
        tokens: canonicalTokens(entry, words, options),
      })
    : contextualFailure(values, words);
}
export function parseCommandTokens(
  tokens: readonly string[],
): Result<ParsedCommand, CommandParseError> {
  const result = parseCommandInvocation(tokens);
  return result.ok ? success(result.value.command) : result;
}
/** Help uses the same option reader, including native-host transport defaults. */
export function commandHelpPaths(tokens: readonly string[]): readonly CommandPath[] {
  const split = splitOptions(tokens[0] === "wm" ? tokens.slice(1) : tokens);
  const words = split.ok ? split.value.words : tokens;
  return [...commandPaths, ...serviceCommandPaths, ...hostCommandPaths].filter(
    (path) =>
      words.length <= path.tokens.length &&
      words.every((word, index) => {
        const token = path.tokens[index]!;
        return token.kind === "slot" || token.value === word;
      }),
  );
}
export function parseCommandText(text: string): Result<ParsedCommand, CommandParseError> {
  try {
    return parseCommandTokens(tokenizeCommandText(text));
  } catch (cause) {
    return failure(
      "invalid_text",
      cause instanceof Error
        ? cause.message.replace("Invalid wm command: ", "Cannot parse command: ")
        : String(cause),
    );
  }
}
/** Compatibility helpers for adapters; all grammar lives in parseCommandTokens. */
export function buildCommand(
  verb: string,
  rest: string[],
  flags: Record<string, string | boolean> = {},
): Command | null {
  const tokens = [
    verb,
    ...rest,
    ...Object.entries(flags).flatMap(([name, value]) =>
      value === true ? [`--${name}`] : value === false ? [] : [`--${name}`, value],
    ),
  ];
  const result = parseCommandTokens(tokens);
  return result.ok && isEngineCommand(result.value) ? result.value : null;
}
export function buildKeybindCommand(action: string): Command | null {
  const result = parseCommandText(action);
  return result.ok && isEngineCommand(result.value) ? result.value : null;
}

export function formatCommandHelp(paths: readonly CommandPath[] = commandPaths): string {
  return paths
    .map(
      (path) =>
        `  ${path.tokens
          .map((token) =>
            token.kind === "literal"
              ? token.value
              : `<${token.label.toLowerCase().replaceAll(" ", "-")}>`,
          )
          .join(" ")
          .padEnd(64)} ${path.description ?? ""}`,
    )
    .join("\n");
}
export interface DescribedCommandToken {
  readonly value: string;
  readonly description: string;
}
export function describeCommandTokens(
  text: string,
  paths: readonly CommandPath[] = commandPaths,
): DescribedCommandToken[] {
  const words = tokenizeCommandText(text);
  const prefixed = words[0] === "wm";
  if (prefixed) words.shift();
  const path = paths.find((candidate) => matches(candidate, words));
  const described = words.map((value, index) => ({
    value: /\s|["'\\]/u.test(value) ? quoteCommandToken(value) : value,
    description:
      path?.tokens[index]?.description ?? path?.description ?? "A window-manager command token.",
  }));
  return prefixed
    ? [{ value: "wm", description: "Invoke the window manager." }, ...described]
    : described;
}
export function quoteCommandToken(value: string): string {
  return `"${value.replace(/[\\"]/gu, "\\$&")}"`;
}
/** Portable data tokenizer; shell execution and command chaining are unsupported. */
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
    } else if (character === "'" || character === '"') {
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
    } else if (/[;|&<>`$(){}[\]*?~!#]/.test(character))
      throw new Error(`Invalid wm command: unquoted shell character ${character}`);
    else {
      word += character;
      started = true;
    }
  }
  if (quote !== null) throw new Error("Invalid wm command: unterminated quote");
  if (started) words.push(word);
  return words;
}
