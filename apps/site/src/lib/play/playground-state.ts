import type {
  ScenarioEvent,
  SimulationDisplay,
  SimulationState,
  SimulationWindow,
} from "@paneform/layout-browser";

export function physicalDisplay(
  display: SimulationDisplay,
): Extract<ScenarioEvent, { kind: "topology_changed" }>["topology"][number] {
  const { workspace: _workspace, ...physical } = display;
  return physical;
}

export function physicalWindow(
  window: SimulationWindow,
): Extract<ScenarioEvent, { kind: "window_changed" }>["window"] {
  const { workspace: _workspace, floating: _floating, ...physical } = window;
  return physical;
}

/** Setup edits describe facts; they must not run assignment or repair policies. */
export function editStartingState(
  state: SimulationState,
  event: ScenarioEvent,
  displayId?: string,
): SimulationState {
  switch (event.kind) {
    case "window_added": {
      const target =
        state.topology.find((display) => display.id === displayId) ?? state.topology[0];
      const used = new Set([
        ...state.topology.map((display) => display.workspace),
        ...state.windows.map((window) => (window.workspace === undefined ? "1" : window.workspace)),
      ]);
      let available = 1;
      while (used.has(String(available))) available += 1;
      const workspace = target?.workspace ?? String(available);
      return {
        ...state,
        topology: state.topology.map((display) =>
          display.id === target?.id ? { ...display, workspace } : display,
        ),
        windows: [...state.windows, { ...event.window, workspace }],
      };
    }
    case "window_changed":
      return {
        ...state,
        windows: state.windows.map((window) =>
          window.id === event.window.id ? { ...window, ...event.window } : window,
        ),
      };
    case "window_removed":
      return {
        ...state,
        windows: state.windows.filter((window) => window.id !== event.windowId),
        focusedWindow: state.focusedWindow === event.windowId ? null : state.focusedWindow,
      };
    case "focus_changed": {
      const window = state.windows.find(({ id }) => id === event.windowId);
      return {
        ...state,
        focusedWindow: event.windowId,
        focusedWorkspace: window
          ? window.workspace === undefined
            ? "1"
            : window.workspace
          : state.focusedWorkspace,
      };
    }
    default:
      throw new Error("This event belongs in the scenario steps, not a starting-window edit.");
  }
}
