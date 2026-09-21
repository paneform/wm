import { describe, expect, it } from "vitest";

import {
  cancelWindowDragCapture,
  createWindowDragCapture,
  finishWindowDragCapture,
  updateWindowDragCapture,
} from "$lib/desktop/window-drag-capture.js";

const viewport = { x: 100, y: 200, width: 1_000, height: 500 };
const bounds = { left: 10, top: 20, width: 500, height: 250 };
const frame = { x: 120, y: 240, width: 300, height: 200 };

describe("window drag capture", () => {
  it("records logical global endpoints and clamps duration", () => {
    const capture = createWindowDragCapture("window:1", frame, 10, 20, 5_000, bounds, viewport);
    updateWindowDragCapture(capture, 510, 270, 125_000, bounds, viewport);

    expect(finishWindowDragCapture(capture)).toEqual({
      windowId: "window:1",
      startFrame: frame,
      from: { x: 100, y: 200 },
      to: { x: 1_100, y: 700 },
      duration: 60_000,
    });
  });

  it("uses maximum excursion so an out-and-back drag is retained", () => {
    const capture = createWindowDragCapture("window:1", frame, 20, 30, 0, bounds, viewport);
    updateWindowDragCapture(capture, 24, 30, 10, bounds, viewport);
    updateWindowDragCapture(capture, 20, 30, 20, bounds, viewport);

    expect(finishWindowDragCapture(capture)).toMatchObject({
      from: { x: 120, y: 220 },
      to: { x: 120, y: 220 },
      duration: 20,
    });
  });

  it("returns no gesture for clicks and canceled captures", () => {
    const click = createWindowDragCapture("window:1", frame, 20, 30, 0, bounds, viewport);
    updateWindowDragCapture(click, 22, 30, 10, bounds, viewport);
    expect(finishWindowDragCapture(click)).toBeNull();

    const canceled = createWindowDragCapture("window:1", frame, 20, 30, 0, bounds, viewport);
    updateWindowDragCapture(canceled, 30, 30, 10, bounds, viewport);
    cancelWindowDragCapture(canceled);
    expect(finishWindowDragCapture(canceled)).toBeNull();
  });

  it("uses the minimum duration for an immediate release", () => {
    const capture = createWindowDragCapture("window:1", frame, 20, 30, 10, bounds, viewport);
    updateWindowDragCapture(capture, 30, 30, 10, bounds, viewport);
    expect(finishWindowDragCapture(capture)?.duration).toBe(1);
  });
});
