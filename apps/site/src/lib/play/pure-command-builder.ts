import {
  quoteCommandToken,
  tokenizeCommandText,
  type CommandPath,
  type CommandToken,
} from "@paneform/layout";
import {
  parseScenarioCommand,
  scenarioCommandPaths,
  type LayoutScenario,
  type ScenarioStep,
} from "@paneform/layout-browser";

export type CommandContext = {
  readonly windows: readonly string[];
  readonly displays: readonly string[];
  readonly workspaces: readonly string[];
};

export type AcceptedCommandToken = {
  readonly value: string;
  readonly kind: "literal" | "window" | "display" | "workspace" | "coordinate" | "dimension";
  readonly label: string;
  readonly paths: readonly number[];
};

export type CommandBuilderState = {
  readonly accepted: readonly AcceptedCommandToken[];
  readonly query: string;
};

export type CommandChoice = {
  readonly value: string;
  readonly label: string;
  readonly kind: AcceptedCommandToken["kind"];
  readonly paths: readonly number[];
};

export const emptyCommandState = (): CommandBuilderState => ({ accepted: [], query: "" });

export function deriveCommandContext(
  scenario: LayoutScenario,
  draftSteps: readonly ScenarioStep[] = scenario.steps ?? [],
  beforeStep = draftSteps.length,
): CommandContext {
  const windows = new Set(scenario.state.windows.map(({ id }) => id));
  let displays = scenario.state.topology.map(({ id }) => id);
  const workspaces = new Set<string>();
  for (const display of scenario.state.topology)
    if (display.workspace !== null) workspaces.add(display.workspace);
  for (const window of scenario.state.windows) {
    const workspace = window.workspace === undefined ? "1" : window.workspace;
    if (workspace !== null) workspaces.add(workspace);
  }
  for (const workspace of scenario.config?.workspaces ?? []) workspaces.add(workspace.name);

  for (const step of draftSteps.slice(0, Math.max(0, beforeStep))) {
    if ("event" in step) {
      if (step.event.kind === "window_added" || step.event.kind === "window_changed")
        windows.add(step.event.window.id);
      else if (step.event.kind === "window_removed") windows.delete(step.event.windowId);
      else if (step.event.kind === "topology_changed")
        displays = step.event.topology.map(({ id }) => id);
      continue;
    }
    try {
      const command = parseScenarioCommand(step.command);
      if ("workspace" in command && command.workspace !== undefined)
        workspaces.add(command.workspace);
      if (command.type === "focusWorkspace") workspaces.add(command.name);
    } catch {
      // Invalid imported commands are reported by full scenario validation.
    }
  }
  return { windows: [...windows], displays, workspaces: [...workspaces] };
}

function descriptor(path: CommandPath, position: number): CommandToken | undefined {
  return path.tokens[position];
}

function possiblePaths(state: CommandBuilderState): readonly number[] {
  if (state.accepted.length === 0) return scenarioCommandPaths.map((_, index) => index);
  return state.accepted.at(-1)?.paths ?? [];
}

function valuesFor(token: CommandToken, context: CommandContext): readonly string[] {
  if (token.kind === "literal") return [token.value];
  if (token.slot === "window") return context.windows;
  if (token.slot === "display") return context.displays;
  if (token.slot === "workspace") return context.workspaces;
  return [];
}

function requiresKnownValue(token: CommandToken): boolean {
  return (
    token.kind === "slot" &&
    (token.slot === "window" || token.slot === "display" || token.slot === "workspace") &&
    !token.allowNew
  );
}

function queryValue(query: string, token: CommandToken, alreadyDecoded = false): string | null {
  let value = alreadyDecoded ? query : query.trim();
  if (token.kind === "literal") return value === token.value ? value : null;
  if (!alreadyDecoded && (value.startsWith('"') || value.startsWith("'"))) {
    try {
      const decoded = tokenizeCommandText(value);
      if (decoded.length !== 1) return null;
      value = decoded[0]!;
      alreadyDecoded = true;
    } catch {
      return null;
    }
  }
  if (token.slot === "coordinate" || token.slot === "dimension") {
    const number = Number(value);
    if (value === "" || !Number.isFinite(number) || (token.slot === "dimension" && number <= 0))
      return null;
    return value;
  }
  if (!value.trim() || value.length > 128 || value.startsWith("--")) return null;
  if (token.slot === "workspace" && token.allowNew) {
    if (!alreadyDecoded && /\s/u.test(value)) return null;
    return value;
  }
  return value;
}

export function commandChoices(
  state: CommandBuilderState,
  context: CommandContext,
  limit = 50,
): readonly CommandChoice[] {
  const rawQuery = state.query.trim();
  const query = rawQuery.replace(/^['"]/u, "").toLowerCase();
  let decodedQuery: string | null = rawQuery;
  if (rawQuery.startsWith('"') || rawQuery.startsWith("'")) {
    try {
      const decoded = tokenizeCommandText(rawQuery);
      decodedQuery = decoded.length === 1 ? decoded[0]! : null;
    } catch {
      decodedQuery = null;
    }
  }
  const choices: CommandChoice[] = [];
  const seen = new Set<string>();
  const position = state.accepted.length;
  const add = (choice: CommandChoice) => {
    const key = `${choice.kind}\0${choice.value}`;
    const existing = choices.find((item) => `${item.kind}\0${item.value}` === key);
    if (existing) {
      const index = choices.indexOf(existing);
      choices[index] = { ...existing, paths: [...new Set([...existing.paths, ...choice.paths])] };
    } else if (!seen.has(key)) {
      seen.add(key);
      choices.push(choice);
    }
  };
  for (const pathIndex of possiblePaths(state)) {
    const token = descriptor(scenarioCommandPaths[pathIndex]!, position);
    if (!token) continue;
    for (const value of valuesFor(token, context)) {
      if (!value.toLowerCase().startsWith(query)) continue;
      const kind = token.kind === "literal" ? "literal" : token.slot;
      add({
        value,
        kind,
        label: token.kind === "literal" ? value : token.label,
        paths: [pathIndex],
      });
    }
  }
  for (const pathIndex of possiblePaths(state)) {
    const token = descriptor(scenarioCommandPaths[pathIndex]!, position);
    if (!token) continue;
    const value = queryValue(state.query, token);
    if (value === null || token.kind === "literal") continue;
    if (requiresKnownValue(token) && !valuesFor(token, context).includes(value)) continue;
    add({ value, kind: token.slot, label: token.label, paths: [pathIndex] });
  }
  choices.sort((left, right) => {
    const exact = (choice: CommandChoice) =>
      choice.kind === "literal"
        ? choice.value.toLowerCase() === query
        : decodedQuery !== null && choice.value === decodedQuery;
    return Number(exact(right)) - Number(exact(left));
  });
  return choices.slice(0, Math.max(0, Math.min(50, limit)));
}

export function commandSlotHint(state: CommandBuilderState): string {
  const position = state.accepted.length;
  const tokens = possiblePaths(state)
    .map((index) => descriptor(scenarioCommandPaths[index]!, position))
    .filter((token): token is CommandToken => token !== undefined);
  if (tokens.length === 0) return "Command complete";
  const token = tokens[0]!;
  if (token.kind === "literal")
    return position === 0 ? "Choose a command" : "Choose the next command word";
  if (token.slot === "window") return "Choose window";
  if (token.slot === "display") return "Choose display";
  if (token.slot === "workspace")
    return token.allowNew ? "Enter workspace name" : "Choose workspace";
  return `Enter ${token.label.toLowerCase()}`;
}

export function acceptCommandChoice(
  state: CommandBuilderState,
  choice: CommandChoice,
): CommandBuilderState {
  return {
    accepted: [...state.accepted, { ...choice }],
    query: "",
  };
}

export function acceptTypedCommandToken(
  state: CommandBuilderState,
  context: CommandContext,
): CommandBuilderState | null {
  const position = state.accepted.length;
  const matches = new Map<string, CommandChoice>();
  for (const pathIndex of possiblePaths(state)) {
    const token = descriptor(scenarioCommandPaths[pathIndex]!, position);
    if (!token) continue;
    const value = queryValue(state.query, token);
    if (value === null) continue;
    if (requiresKnownValue(token) && !valuesFor(token, context).includes(value)) continue;
    const kind = token.kind === "literal" ? "literal" : token.slot;
    const key = `${kind}\0${value}`;
    const match = matches.get(key);
    if (match) matches.set(key, { ...match, paths: [...match.paths, pathIndex] });
    else
      matches.set(key, {
        value,
        kind,
        label: token.kind === "literal" ? value : token.label,
        paths: [pathIndex],
      });
  }
  return matches.size === 1 ? acceptCommandChoice(state, [...matches.values()][0]!) : null;
}

export function reopenCommandToken(
  state: CommandBuilderState,
  index = state.accepted.length - 1,
): CommandBuilderState {
  if (index < 0 || index >= state.accepted.length) return state;
  const token = state.accepted[index]!;
  const query =
    token.kind === "window" || token.kind === "workspace" || token.kind === "display"
      ? quoteCommandToken(token.value)
      : token.value;
  return { accepted: state.accepted.slice(0, index), query };
}

export function sanitizeCommandState(
  state: CommandBuilderState,
  context: CommandContext,
): CommandBuilderState {
  const accepted: AcceptedCommandToken[] = [];
  for (const [position, token] of state.accepted.entries()) {
    const paths = token.paths.filter((pathIndex) => {
      const expected = descriptor(scenarioCommandPaths[pathIndex]!, position);
      return (
        !expected ||
        !requiresKnownValue(expected) ||
        valuesFor(expected, context).includes(token.value)
      );
    });
    if (paths.length === 0) break;
    accepted.push(paths.length === token.paths.length ? token : { ...token, paths });
  }
  return accepted.length === state.accepted.length &&
    accepted.every((token, index) => token === state.accepted[index])
    ? state
    : { accepted, query: "" };
}

export function serializeCommandTokens(tokens: readonly AcceptedCommandToken[]): string {
  return tokens
    .map(({ value, kind }) =>
      kind === "literal" || /^[\w./:@+-]+$/u.test(value) ? value : quoteCommandToken(value),
    )
    .join(" ");
}

export function completedCommand(state: CommandBuilderState): string | null {
  const count = state.accepted.length;
  if (state.query !== "") return null;
  const complete = possiblePaths(state).some((index) => {
    const path = scenarioCommandPaths[index]!;
    return (
      count === path.tokens.length ||
      (count >= (path.minimumTokens ?? path.tokens.length) && count < path.tokens.length)
    );
  });
  if (!complete) return null;
  const command = serializeCommandTokens(state.accepted);
  try {
    const roundTrip = tokenizeCommandText(command);
    if (
      roundTrip.length !== state.accepted.length ||
      roundTrip.some((value, index) => value !== state.accepted[index]?.value)
    )
      return null;
    parseScenarioCommand(command);
    return command;
  } catch {
    return null;
  }
}

export function commandStateFromText(
  text: string,
  context: CommandContext,
): CommandBuilderState | null {
  let words: string[];
  try {
    words = tokenizeCommandText(text);
  } catch {
    return null;
  }
  if (words[0] === "wm") words.shift();
  const matchingPaths: number[] = [];
  for (const [pathIndex, path] of scenarioCommandPaths.entries()) {
    const minimum = path.minimumTokens ?? path.tokens.length;
    if (words.length < minimum || words.length > path.tokens.length) continue;
    let matches = true;
    for (const [index, word] of words.entries()) {
      const token = path.tokens[index]!;
      const value = queryValue(word, token, true);
      if (
        value === null ||
        (requiresKnownValue(token) && !valuesFor(token, context).includes(value))
      ) {
        matches = false;
        break;
      }
    }
    if (matches) matchingPaths.push(pathIndex);
  }
  const selectedPath = scenarioCommandPaths[matchingPaths[0] ?? -1];
  if (!selectedPath) return null;

  const accepted = words.map((value, position): AcceptedCommandToken => {
    const selected = selectedPath.tokens[position]!;
    const kind = selected.kind === "literal" ? "literal" : selected.slot;
    const paths = scenarioCommandPaths.flatMap((path, pathIndex) => {
      const candidate = path.tokens[position];
      if (!candidate || (candidate.kind === "literal" ? "literal" : candidate.slot) !== kind)
        return [];
      for (let index = 0; index <= position; index++) {
        const token = path.tokens[index];
        const word = words[index]!;
        if (!token || queryValue(word, token, true) === null) return [];
        if (requiresKnownValue(token) && !valuesFor(token, context).includes(word)) return [];
      }
      return [pathIndex];
    });
    return {
      value,
      kind,
      label: selected.kind === "literal" ? value : selected.label,
      paths,
    };
  });
  const state = { accepted, query: "" };
  return completedCommand(state) === null ? null : state;
}
