import type { Frame } from "../desktop/desktop-model.js";

export const resizeEdges = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
export type ResizeEdge = (typeof resizeEdges)[number];

export function resizeFrame(frame: Frame, edge: ResizeEdge, dx: number, dy: number): Frame {
  const width = Math.max(
    160,
    frame.width + (edge.includes("w") ? -dx : edge.includes("e") ? dx : 0),
  );
  const height = Math.max(
    100,
    frame.height + (edge.includes("n") ? -dy : edge.includes("s") ? dy : 0),
  );
  return {
    x: edge.includes("w") ? frame.x + frame.width - width : frame.x,
    y: edge.includes("n") ? frame.y + frame.height - height : frame.y,
    width,
    height,
  };
}
