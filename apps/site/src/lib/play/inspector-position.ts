export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface InspectorPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  placement: "left" | "right" | "sheet";
}

export const INSPECTOR_GUTTER = 12;
export const INSPECTOR_GAP = 12;
export const INSPECTOR_WIDTH = 312;

export function positionInspector(
  anchor: ViewportRect,
  viewport: { width: number; height: number; left?: number; top?: number },
  panelHeight = viewport.height,
): InspectorPosition {
  const viewportLeft = viewport.left ?? 0;
  const viewportTop = viewport.top ?? 0;
  const viewportRight = viewportLeft + viewport.width;
  const viewportBottom = viewportTop + viewport.height;
  const availableWidth = Math.max(0, viewport.width - INSPECTOR_GUTTER * 2);
  const width = Math.min(INSPECTOR_WIDTH, availableWidth);
  const maxHeight = Math.max(0, viewport.height - INSPECTOR_GUTTER * 2);
  const right = anchor.left + anchor.width + INSPECTOR_GAP;
  const left = anchor.left - INSPECTOR_GAP - width;
  const top = clamp(
    anchor.top,
    viewportTop + INSPECTOR_GUTTER,
    Math.max(
      viewportTop + INSPECTOR_GUTTER,
      viewportBottom - INSPECTOR_GUTTER - Math.min(panelHeight, maxHeight),
    ),
  );

  if (right + width <= viewportRight - INSPECTOR_GUTTER)
    return { left: right, top, width, maxHeight, placement: "right" };
  if (left >= viewportLeft + INSPECTOR_GUTTER)
    return { left, top, width, maxHeight, placement: "left" };

  const sheetMaxHeight = Math.max(0, Math.min(maxHeight, viewport.height * 0.6));
  return {
    left: clamp(
      anchor.left,
      viewportLeft + INSPECTOR_GUTTER,
      Math.max(viewportLeft + INSPECTOR_GUTTER, viewportRight - INSPECTOR_GUTTER - width),
    ),
    top: Math.max(
      viewportTop + INSPECTOR_GUTTER,
      viewportBottom - INSPECTOR_GUTTER - Math.min(panelHeight, sheetMaxHeight),
    ),
    width,
    maxHeight: sheetMaxHeight,
    placement: "sheet",
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}
