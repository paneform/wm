import {
  parseScenario,
  playbackStartIndex,
  type LayoutScenario,
  type ScenarioStep,
  type SimulationState,
} from "@paneform/layout-browser";

/**
 * The two pane scenes an action is applied to. Actions are recorded only when
 * they change at least one scene; applying a value the scene already has is a
 * no-op, while a rejected attempt that resets geometry still changes it.
 */
export interface PaneStates {
  primary: SimulationState;
  comparison: SimulationState | null;
}

/** An action that leaves both pane scenes untouched records nothing. */
export function sceneChanged(before: PaneStates, after: PaneStates): boolean {
  return (
    JSON.stringify(before.primary) !== JSON.stringify(after.primary) ||
    JSON.stringify(before.comparison) !== JSON.stringify(after.comparison)
  );
}

/** Playback falls back to this duration for steps without an explicit one. */
export const defaultStepDuration = 1_200;

export interface RailGeometry {
  readonly stops: readonly number[];
  positionAt(stop: number): number;
}

/**
 * Scrub-rail geometry: pips mark resolved states, so the starting state sits at
 * zero, each step's pip sits at the end of its own stretch (spacing reflects
 * durations), and no track follows the last pip. Percentages of the rail width.
 */
export function proportionalRail(durations: readonly number[]): RailGeometry {
  const total = durations.reduce((sum, value) => sum + value, 0);
  const stops: number[] = [0];
  let elapsed = 0;
  for (const duration of durations) {
    elapsed += total > 0 ? duration : 1;
    stops.push((elapsed / (total > 0 ? total : durations.length)) * 100);
  }
  return {
    stops,
    positionAt: (stop) => {
      if (stop < 0) return 0;
      if (stop >= stops.length) return 100;
      return stops[stop]!;
    },
  };
}

export function insertScenarioStep(scenario: LayoutScenario, cursor: number, step: ScenarioStep) {
  return { ...insertScenarioSteps(scenario, cursor, [step]), step };
}

export function insertScenarioSteps(
  scenario: LayoutScenario,
  cursor: number,
  inserted: readonly ScenarioStep[],
) {
  const steps = scenario.steps ?? [];
  const start = playbackStartIndex(steps);
  if (!Number.isInteger(cursor) || cursor < -1 || cursor >= steps.length - start) {
    throw new Error("An action can only be recorded at the current scenario position.");
  }
  const index = start + cursor + 1;
  const next = [...steps.slice(0, index), ...inserted, ...steps.slice(index)];
  if (cursor === -1 && inserted.length > 0 && steps[start]?.playback === "start") {
    const { playback: _marker, ...original } = next[index + inserted.length]!;
    next[index + inserted.length] = original;
    next[index] = { ...next[index]!, playback: "start" };
  }
  return {
    index: cursor + inserted.length,
    steps: inserted,
    scenario: parseScenario({
      ...scenario,
      steps: next,
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
  const start = playbackStartIndex(previous);
  const nextStart = playbackStartIndex(next);
  return (
    sessionMatchesCursor &&
    start === nextStart &&
    next.length - nextStart > cursor &&
    JSON.stringify(previous.slice(0, start + cursor + 1)) ===
      JSON.stringify(next.slice(0, nextStart + cursor + 1))
  );
}
