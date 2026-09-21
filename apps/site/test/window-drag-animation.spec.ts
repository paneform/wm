import { describe, expect, it, vi } from "vitest";

import { presentWindowDrag, type DragAnimationScheduler } from "$lib/play/window-drag-animation.js";
import type { WindowDragPreview } from "$lib/desktop/window-drag-types.js";
import type { WindowDrag } from "@paneform/layout-browser";

const gesture: WindowDrag = {
  windowId: "window:1",
  displayId: "display:1",
  startFrame: { x: 10, y: 20, width: 300, height: 200 },
  from: { x: 20, y: 30 },
  to: { x: 120, y: 80 },
  duration: 200,
};

function scheduler(frames: number[] = []): DragAnimationScheduler & { waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    now: () => 1_000,
    nextFrame: async () => frames.shift() ?? 1_300,
    wait: async (ms) => {
      waits.push(ms);
    },
  };
}

describe("presentWindowDrag", () => {
  it("replays, commits at release, holds, settles, and clears in order", async () => {
    const events: string[] = [];
    const previews: WindowDragPreview[] = [];
    const timing = scheduler([1_150, 1_300]);

    await presentWindowDrag(gesture, {
      signal: new AbortController().signal,
      animate: true,
      scheduler: timing,
      onPreview: (value) => {
        events.push(value?.phase ?? "clear");
        if (value) previews.push(value);
      },
      submit: async () => {
        events.push("submit");
        expect(previews.at(-1)?.phase).toBe("released");
      },
    });

    expect(events).toEqual([
      "pressed",
      "dragging",
      "dragging",
      "released",
      "submit",
      "settling",
      "clear",
    ]);
    expect(timing.waits).toEqual([120, 100, 420]);
    expect(previews[1]).toMatchObject({
      frame: { x: 60, y: 45 },
      pointer: { x: 70, y: 55 },
    });
  });

  it("waits for submission before leaving the released phase", async () => {
    let finishSubmit!: () => void;
    const submission = new Promise<void>((resolve) => (finishSubmit = resolve));
    const phases: string[] = [];
    const run = presentWindowDrag(gesture, {
      signal: new AbortController().signal,
      animate: true,
      live: true,
      scheduler: scheduler(),
      onPreview: (value) => phases.push(value?.phase ?? "clear"),
      submit: vi.fn(() => submission),
    });

    await Promise.resolve();
    expect(phases).toEqual(["released"]);
    finishSubmit();
    await run;
    expect(phases).toEqual(["released", "settling", "clear"]);
  });

  it("clears and does not submit when aborted before release", async () => {
    const controller = new AbortController();
    const submit = vi.fn(async () => {});
    const phases: string[] = [];
    const timing: DragAnimationScheduler = {
      now: () => 0,
      nextFrame: async () => 0,
      wait: async (_ms, signal) => {
        controller.abort();
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      },
    };

    await expect(
      presentWindowDrag(gesture, {
        signal: controller.signal,
        animate: true,
        scheduler: timing,
        onPreview: (value) => phases.push(value?.phase ?? "clear"),
        submit,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(submit).not.toHaveBeenCalled();
    expect(phases).toEqual(["pressed", "clear"]);
  });

  it("awaits an in-flight submit and skips remaining visuals after abort", async () => {
    const controller = new AbortController();
    let finishSubmit!: () => void;
    const submit = vi.fn(() => new Promise<void>((resolve) => (finishSubmit = resolve)));
    const phases: string[] = [];
    const run = presentWindowDrag(gesture, {
      signal: controller.signal,
      animate: true,
      live: true,
      scheduler: scheduler(),
      onPreview: (value) => phases.push(value?.phase ?? "clear"),
      submit,
    });

    controller.abort();
    await Promise.resolve();
    expect(phases).toEqual(["released"]);
    finishSubmit();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(submit).toHaveBeenCalledOnce();
    expect(phases).toEqual(["released", "clear"]);
  });

  it("throws immediately when initially aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const submit = vi.fn(async () => {});
    const onPreview = vi.fn();

    await expect(
      presentWindowDrag(gesture, {
        signal: controller.signal,
        animate: true,
        onPreview,
        submit,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(submit).not.toHaveBeenCalled();
    expect(onPreview).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledWith(null);
  });

  it("submits without programmatic visuals when animation is disabled", async () => {
    const calls: string[] = [];
    await presentWindowDrag(gesture, {
      signal: new AbortController().signal,
      animate: false,
      onPreview: (value) => calls.push(value ? value.phase : "clear"),
      submit: async () => {
        calls.push("submit");
      },
    });

    expect(calls).toEqual(["submit", "clear"]);
  });

  it("uses the gesture duration when it exceeds the minimum", async () => {
    const progress: number[] = [];
    const longGesture = { ...gesture, duration: 600 };
    await presentWindowDrag(longGesture, {
      signal: new AbortController().signal,
      animate: true,
      scheduler: scheduler([1_300, 1_600]),
      onPreview: (value) => {
        if (value?.phase === "dragging") progress.push(value.pointer.x);
      },
      submit: async () => {},
    });

    expect(progress).toEqual([70, 120]);
  });
});
