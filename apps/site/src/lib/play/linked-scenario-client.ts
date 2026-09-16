import type { LayoutScenario, ScenarioStep, SimulationState } from "@paneform/layout-browser";
import { comparisonForScenario } from "./comparison-config.js";
import { createScenarioClient, type ScenarioClient } from "./scenario-client.js";

export interface LinkedScenarioState {
  primary: SimulationState;
  comparison: SimulationState | null;
}

export interface LinkedScenarioClient {
  snapshot(): Promise<LinkedScenarioState>;
  apply(step: ScenarioStep): Promise<LinkedScenarioState>;
  dispose(): Promise<void>;
}

export type ScenarioClientFactory = (
  scenario: LayoutScenario,
  signal?: AbortSignal,
) => Promise<Pick<ScenarioClient, "snapshot" | "apply" | "dispose">>;

const defaultClientFactory: ScenarioClientFactory = (scenario, signal) =>
  createScenarioClient(scenario, undefined, 5_000, signal);

function pairedError(
  results: readonly PromiseSettledResult<unknown>[],
  labels: readonly string[],
): Error | null {
  const failures = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [
          `${labels[index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        ]
      : [],
  );
  return failures.length === 0 ? null : new Error(failures.join("\n"));
}

export async function createLinkedScenarioClient(
  scenario: LayoutScenario,
  signal?: AbortSignal,
  createClient: ScenarioClientFactory = defaultClientFactory,
): Promise<LinkedScenarioClient> {
  const comparison = comparisonForScenario(scenario);
  const inputs =
    comparison !== undefined
      ? [
          {
            ...structuredClone(scenario),
            simulation: { ...scenario.simulation, os: comparison.primary.os },
          },
          {
            ...structuredClone(scenario),
            simulation: { ...scenario.simulation, os: comparison.secondary.os },
          },
        ]
      : [scenario];
  const labels =
    comparison === undefined
      ? ["Scenario"]
      : [
          comparison.primary.label.trim() || "Left simulation",
          comparison.secondary.label.trim() || "Right simulation",
        ];
  const created = await Promise.allSettled(
    inputs.map((input) => Promise.resolve().then(() => createClient(input, signal))),
  );
  const creationError = pairedError(created, labels);
  if (creationError !== null) {
    await Promise.allSettled(
      created.flatMap((result) =>
        result.status === "fulfilled" ? [Promise.resolve().then(() => result.value.dispose())] : [],
      ),
    );
    throw creationError;
  }

  const clients = created.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
  let poisoned = false;
  let disposed = false;
  let closing: Promise<void> | undefined;
  let tail: Promise<void> = Promise.resolve();
  let signalDisposal = () => {};
  const disposalSignal = new Promise<void>((resolve) => {
    signalDisposal = resolve;
  });

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    if (disposed) return Promise.reject(new Error("Linked scenario has been disposed"));
    const result = tail.then(() => {
      if (disposed) throw new Error("Linked scenario has been disposed");
      return operation();
    });
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return Promise.race([
      result,
      disposalSignal.then(() => {
        throw new Error("Linked scenario has been disposed");
      }),
    ]);
  };

  const collect = async (
    operation: (client: (typeof clients)[number], index: number) => Promise<SimulationState>,
  ): Promise<LinkedScenarioState> => {
    const results = await Promise.allSettled(
      clients.map((client, index) => Promise.resolve().then(() => operation(client, index))),
    );
    const error = pairedError(results, labels);
    if (error !== null) throw error;
    const states = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const primary = states[0];
    if (primary === undefined) throw new Error(`${labels[0]} returned no state`);
    return {
      primary,
      comparison: states[1] ?? null,
    };
  };

  return {
    snapshot: () => enqueue(() => collect((client) => client.snapshot())),
    apply: (step) =>
      enqueue(async () => {
        if (poisoned) throw new Error("Linked scenario stopped after a failed apply; recreate it");
        try {
          return await collect((client) => client.apply(structuredClone(step)));
        } catch (error) {
          poisoned = true;
          throw error;
        }
      }),
    dispose: () => {
      if (closing !== undefined) return closing;
      disposed = true;
      signalDisposal();
      closing = Promise.allSettled(
        clients.map((client) => Promise.resolve().then(() => client.dispose())),
      ).then((results) => {
        const error = pairedError(results, labels);
        if (error !== null) throw error;
      });
      return closing;
    },
  };
}
