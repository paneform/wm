import type { Frame, Point } from "@paneform/layout";

import type { SurfaceWindowDrag } from "./window-drag-types.js";

const MAX_DURATION = 60_000;
const DRAG_THRESHOLD = 3;

interface CapturedPointer extends Point {
  readonly clientX: number;
  readonly clientY: number;
  readonly timeStamp: number;
}

export interface SurfaceBounds {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface WindowDragCapture {
  readonly windowId: string;
  readonly startFrame: Frame;
  readonly start: CapturedPointer;
  end: CapturedPointer;
  maxCssExcursion: number;
  canceled: boolean;
}

export function logicalPointer(
  clientX: number,
  clientY: number,
  bounds: SurfaceBounds,
  viewport: Frame,
): Point {
  return {
    x: viewport.x + ((clientX - bounds.left) / bounds.width) * viewport.width,
    y: viewport.y + ((clientY - bounds.top) / bounds.height) * viewport.height,
  };
}

export function createWindowDragCapture(
  windowId: string,
  startFrame: Frame,
  clientX: number,
  clientY: number,
  timeStamp: number,
  bounds: SurfaceBounds,
  viewport: Frame,
): WindowDragCapture {
  const start = {
    clientX,
    clientY,
    timeStamp,
    ...logicalPointer(clientX, clientY, bounds, viewport),
  };
  return {
    windowId,
    startFrame: { ...startFrame },
    start,
    end: start,
    maxCssExcursion: 0,
    canceled: false,
  };
}

export function updateWindowDragCapture(
  capture: WindowDragCapture,
  clientX: number,
  clientY: number,
  timeStamp: number,
  bounds: SurfaceBounds,
  viewport: Frame,
): Point {
  const point = logicalPointer(clientX, clientY, bounds, viewport);
  capture.end = {
    clientX,
    clientY,
    timeStamp,
    ...point,
  };
  capture.maxCssExcursion = Math.max(
    capture.maxCssExcursion,
    Math.hypot(clientX - capture.start.clientX, clientY - capture.start.clientY),
  );
  return point;
}

export function cancelWindowDragCapture(capture: WindowDragCapture): void {
  capture.canceled = true;
}

export function finishWindowDragCapture(capture: WindowDragCapture): SurfaceWindowDrag | null {
  if (capture.canceled || capture.maxCssExcursion < DRAG_THRESHOLD) return null;
  return {
    windowId: capture.windowId,
    startFrame: capture.startFrame,
    from: { x: capture.start.x, y: capture.start.y },
    to: { x: capture.end.x, y: capture.end.y },
    duration: Math.min(MAX_DURATION, Math.max(1, capture.end.timeStamp - capture.start.timeStamp)),
  };
}
