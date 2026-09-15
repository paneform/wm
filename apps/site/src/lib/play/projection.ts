import type { SimulationState } from "@paneform/layout-browser";

type Display = SimulationState["topology"][number];
type WindowState = SimulationState["windows"][number];

export interface ProjectedFrame {
  height: number;
  width: number;
  x: number;
  y: number;
}

function intersects(a: ProjectedFrame, b: ProjectedFrame): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function windowsForDisplay(state: SimulationState, display: Display): WindowState[] {
  return state.windows.filter((window) => {
    if (window.hidden || window.minimized) return false;
    if (state.wmRunning === false) return intersects(window.frame, display.frame);
    const workspace = window.workspace === undefined ? "1" : window.workspace;
    return (
      (workspace !== null && workspace === display.workspace) ||
      (workspace === null && intersects(window.frame, display.frame))
    );
  });
}

export function projectFrame(frame: ProjectedFrame, display: Display): ProjectedFrame {
  return {
    x: ((frame.x - display.frame.x) / display.frame.width) * 100,
    y: ((frame.y - display.frame.y) / display.frame.height) * 100,
    width: (frame.width / display.frame.width) * 100,
    height: (frame.height / display.frame.height) * 100,
  };
}
