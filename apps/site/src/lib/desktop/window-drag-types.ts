import type { Frame, Point } from "@paneform/layout";
import type { WindowDrag } from "@paneform/layout-browser";

export type SurfaceWindowDrag = Omit<WindowDrag, "displayId">;

export interface SurfaceDragPreview {
  readonly windowId: string;
  readonly frame: Frame;
  readonly pointer: Point;
  readonly phase: "pressed" | "dragging" | "released" | "settling";
}

export interface WindowDragPreview extends SurfaceDragPreview {
  readonly displayId: string;
}
