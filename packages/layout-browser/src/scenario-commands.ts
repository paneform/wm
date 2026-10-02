import {
  commandPaths,
  describeCommandTokens,
  parseCommandText,
  serviceCommandPaths,
  isEngineCommand,
  formatCommandParseError,
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
  const result = parseCommandText(input);
  if (!result.ok) throw new Error(formatCommandParseError(result.error));
  const command = result.value;
  if (isEngineCommand(command)) return command;
  if (
    command.type === "service" &&
    (command.action === "start" || command.action === "stop" || command.action === "restart")
  )
    return { type: "service", action: command.action };
  throw new Error("This host command is unavailable in scenarios");
}
