import { Cause, Effect, Exit, Option } from "effect";
import type { Command, CommandResult, Engine } from "@paneform/layout";

/** Execute one engine command and expose its result directly to the wire layer. */
export async function executeEngineCommand(
  engine: Pick<Engine, "execute">,
  command: Command,
): Promise<CommandResult> {
  const exit = await Effect.runPromiseExit(engine.execute(command));
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) throw failure.value;
  throw exit.cause;
}
