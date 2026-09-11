import {
  commandPaths,
  describeCommandTokens,
  parseCommandText,
  serviceCommandPaths,
  tokenizeCommandText,
  type Command,
  type CommandPath,
} from "@paneform/layout";

export type ScenarioServiceCommand = {
  readonly type: "service";
  readonly action: "start" | "stop" | "restart";
};

export type ScenarioCommand = Command | ScenarioServiceCommand;

export const scenarioCommandPaths: readonly CommandPath[] = [
  ...commandPaths,
  ...serviceCommandPaths.filter((path) =>
    path.tokens.some(
      (token) => token.kind === "literal" && ["start", "stop", "restart"].includes(token.value),
    ),
  ),
];

export const describeScenarioCommandTokens = (text: string) => {
  try {
    return describeCommandTokens(text, scenarioCommandPaths);
  } catch {
    return [{ value: text, description: "This command is invalid; edit it before replay." }];
  }
};

export function parseScenarioCommand(input: string): ScenarioCommand {
  const words = tokenizeCommandText(input);
  if (words[0] === "wm") words.shift();
  if (words[0] === "service" && words.length === 2) {
    const action = words[1];
    if (action === "start" || action === "stop" || action === "restart") {
      return { type: "service", action };
    }
  }
  return parseCommandText(input);
}
