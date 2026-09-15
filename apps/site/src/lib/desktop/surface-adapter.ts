import type { Frame, SurfaceWindow } from "./desktop-model.js";

export function mapSurfaceWindows<T extends { id: string; frame: Frame }>(
  windows: readonly T[],
  titleForWindow: (window: T) => string | null,
): SurfaceWindow[] {
  return windows.flatMap((window) => {
    const title = titleForWindow(window);
    return title === null ? [] : [{ id: window.id, title, frame: window.frame }];
  });
}
