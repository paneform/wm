import type { LayoutScenario, SimulationState } from "@paneform/layout-browser";

export interface WorkspaceIndicator {
  windowId: string;
  workspace: string;
  displayId: string;
}

function workspaceDisplay(scenario: LayoutScenario, state: SimulationState, workspace: string) {
  const live = state.topology.find((display) => display.workspace === workspace);
  if (live) return live;
  const preferred = scenario.config?.workspaces?.find(
    (item) => item.name === workspace,
  )?.preferredDisplay;
  const initial = scenario.state.topology.find((display) => display.workspace === workspace)?.id;
  return (
    state.topology.find((display) => display.id === preferred) ??
    state.topology.find((display) => display.id === initial) ??
    state.topology.find((display) => display.primary) ??
    state.topology[0]
  );
}

function physicalDisplay(state: SimulationState, window: SimulationState["windows"][number]) {
  const x = window.frame.x + window.frame.width / 2;
  const y = window.frame.y + window.frame.height / 2;
  return (
    state.topology.find(
      ({ frame }) =>
        x >= frame.x && x < frame.x + frame.width && y >= frame.y && y < frame.y + frame.height,
    ) ??
    state.topology.find((display) => display.primary) ??
    state.topology[0]
  );
}

/** One entry per assigned window, never one copy per display's workspace chip. */
export function workspaceIndicators(
  scenario: LayoutScenario,
  state: SimulationState,
): WorkspaceIndicator[] {
  return state.windows.flatMap((window) => {
    const workspace = window.workspace === undefined ? "1" : window.workspace;
    if (workspace === null) return [];
    const display =
      state.wmRunning === false
        ? physicalDisplay(state, window)
        : workspaceDisplay(scenario, state, workspace);
    return display ? [{ windowId: window.id, workspace, displayId: display.id }] : [];
  });
}
