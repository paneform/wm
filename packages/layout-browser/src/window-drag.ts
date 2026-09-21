import type { Frame, Point } from "@paneform/layout";
import type { WindowDrag } from "./scenario.js";

export function windowDragPointer(drag: WindowDrag, progress: number): Point {
  const clamped = Math.min(1, Math.max(0, progress));
  return {
    x: drag.from.x + (drag.to.x - drag.from.x) * clamped,
    y: drag.from.y + (drag.to.y - drag.from.y) * clamped,
  };
}

export function windowDragFrame(drag: WindowDrag, progress: number): Frame {
  const pointer = windowDragPointer(drag, progress);
  return {
    ...drag.startFrame,
    x: drag.startFrame.x + pointer.x - drag.from.x,
    y: drag.startFrame.y + pointer.y - drag.from.y,
  };
}

export function windowDragTargetFrame(drag: WindowDrag): Frame {
  return windowDragFrame(drag, 1);
}
