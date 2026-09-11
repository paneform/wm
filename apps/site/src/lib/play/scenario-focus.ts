import { parseScenario, type LayoutScenario, type ScenarioStep } from "@paneform/layout-browser";

export function insertScenarioStep(scenario: LayoutScenario, cursor: number, step: ScenarioStep) {
  return { ...insertScenarioSteps(scenario, cursor, [step]), step };
}

export function insertScenarioSteps(
  scenario: LayoutScenario,
  cursor: number,
  inserted: readonly ScenarioStep[],
) {
  const steps = scenario.steps ?? [];
  if (!Number.isInteger(cursor) || cursor < -1 || cursor >= steps.length) {
    throw new Error("An action can only be recorded at the current scenario position.");
  }
  const index = cursor + 1;
  return {
    index: index + inserted.length - 1,
    steps: inserted,
    scenario: parseScenario({
      ...scenario,
      steps: [...steps.slice(0, index), ...inserted, ...steps.slice(index)],
    }),
  };
}

export function nextPlayWindowId(
  scenario: LayoutScenario,
  liveWindowIds: readonly string[],
  sequence: number,
) {
  const reserved = new Set([
    ...scenario.state.windows.map(({ id }) => id),
    ...liveWindowIds,
    ...(scenario.steps ?? []).flatMap((step) =>
      "event" in step && step.event.kind === "window_added" ? [step.event.window.id] : [],
    ),
  ]);
  let nextSequence = sequence;
  let id: string;
  do id = `window:play-${++nextSequence}`;
  while (reserved.has(id));
  return { id, sequence: nextSequence };
}

export function mergeRecordedSteps(
  latest: LayoutScenario,
  expected: LayoutScenario,
  recorded: LayoutScenario,
) {
  const history = ({ state, config, steps }: LayoutScenario) => ({ state, config, steps });
  if (JSON.stringify(history(latest)) !== JSON.stringify(history(expected))) {
    throw new Error("The scenario changed while the desktop action was running.");
  }
  return parseScenario({
    ...latest,
    state: recorded.state,
    config: recorded.config,
    steps: recorded.steps,
  });
}

export function insertFocusStep(
  scenario: LayoutScenario,
  cursor: number,
  windowId: string,
  title = windowId,
) {
  return insertScenarioStep(scenario, cursor, {
    event: { kind: "focus_changed", windowId },
    caption: `Focus ${title}.`,
  });
}

/** Future edits can retain the live session; changing an executed step requires replay. */
export function preservesExecutedSteps(
  previous: readonly ScenarioStep[],
  next: readonly ScenarioStep[],
  cursor: number,
  sessionMatchesCursor: boolean,
): boolean {
  return (
    sessionMatchesCursor &&
    next.length > cursor &&
    JSON.stringify(previous.slice(0, cursor + 1)) === JSON.stringify(next.slice(0, cursor + 1))
  );
}
