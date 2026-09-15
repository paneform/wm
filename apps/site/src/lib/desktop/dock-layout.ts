import type { Frame } from "./desktop-model.js";

export interface DockMetrics {
  iconSize: number;
  gap: number;
  padding: number;
  bottom: number;
  indicatorOffset: number;
  border: number;
}

/** Returns whole CSS-pixel metrics which keep every part of the dock inside the reserved bottom strip. */
export function measureDock(
  frame: Frame,
  workArea: Frame,
  parentWidth: number,
  parentHeight: number,
  itemCount: number,
): DockMetrics | null {
  if (frame.width <= 0 || frame.height <= 0 || parentWidth <= 0 || parentHeight <= 0) return null;
  const reservedModelHeight = frame.y + frame.height - (workArea.y + workArea.height);
  if (reservedModelHeight <= 0) return null;
  const strip = Math.max(0, Math.floor((reservedModelHeight / frame.height) * parentHeight));

  const bottom = Math.min(2, Math.floor(strip / 8));
  const border = strip >= 2 ? 1 : 0;
  const padding = Math.min(3, Math.floor(strip / 8));
  const indicatorOffset = Math.min(2, Math.floor(strip / 10));
  const heightLimit = Math.max(0, strip - bottom - border * 2 - padding * 2 - indicatorOffset);
  const gap = itemCount > 1 ? Math.min(3, Math.max(0, Math.floor(parentWidth / 300))) : 0;
  const widthLimit =
    itemCount > 0
      ? Math.max(
          0,
          Math.floor(
            (parentWidth - 24 - border * 2 - padding * 2 - gap * (itemCount - 1)) / itemCount,
          ),
        )
      : 28;
  const iconSize = Math.max(0, Math.min(28, heightLimit, widthLimit));
  return { iconSize, gap, padding, bottom, indicatorOffset, border };
}
