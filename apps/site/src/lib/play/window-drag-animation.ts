import { windowDragFrame, windowDragPointer, type WindowDrag } from "@paneform/layout-browser";

import type { WindowDragPreview } from "../desktop/window-drag-types.js";

const PRESS_DELAY = 120;
const MIN_DRAG_DURATION = 300;
const RELEASE_HOLD = 100;
const SETTLE_DURATION = 420;

export interface DragAnimationScheduler {
  now(): number;
  nextFrame(signal: AbortSignal): Promise<number>;
  wait(ms: number, signal: AbortSignal): Promise<void>;
}

interface PresentWindowDragOptions {
  readonly signal: AbortSignal;
  readonly animate: boolean;
  readonly live?: boolean;
  readonly onPreview: (preview: WindowDragPreview | null) => void;
  readonly submit: () => Promise<void>;
  readonly scheduler?: DragAnimationScheduler;
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function preview(
  gesture: WindowDrag,
  progress: number,
  phase: WindowDragPreview["phase"],
): WindowDragPreview {
  return {
    windowId: gesture.windowId,
    displayId: gesture.displayId,
    frame: windowDragFrame(gesture, progress),
    pointer: windowDragPointer(gesture, progress),
    phase,
  };
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", cancel, { once: true });

    function finish(): void {
      signal.removeEventListener("abort", cancel);
      resolve();
    }
    function cancel(): void {
      clearTimeout(timer);
      reject(abortError());
    }
  });
}

const browserScheduler: DragAnimationScheduler = {
  now: () => performance.now(),
  nextFrame: (signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      const frame = requestAnimationFrame(finish);
      signal.addEventListener("abort", cancel, { once: true });

      function finish(timestamp: number): void {
        signal.removeEventListener("abort", cancel);
        resolve(timestamp);
      }
      function cancel(): void {
        cancelAnimationFrame(frame);
        reject(abortError());
      }
    }),
  wait,
};

async function replayDrag(
  gesture: WindowDrag,
  signal: AbortSignal,
  scheduler: DragAnimationScheduler,
  onPreview: PresentWindowDragOptions["onPreview"],
): Promise<void> {
  onPreview(preview(gesture, 0, "pressed"));
  await scheduler.wait(PRESS_DELAY, signal);

  const duration = Math.max(MIN_DRAG_DURATION, gesture.duration);
  const startedAt = scheduler.now();
  let progress = 0;
  while (progress < 1) {
    const timestamp = await scheduler.nextFrame(signal);
    progress = Math.min(1, Math.max(0, (timestamp - startedAt) / duration));
    onPreview(preview(gesture, progress, "dragging"));
  }
}

export async function presentWindowDrag(
  gesture: WindowDrag,
  options: PresentWindowDragOptions,
): Promise<void> {
  const { signal, onPreview, submit } = options;

  try {
    throwIfAborted(signal);
    if (!options.animate) {
      await submit();
      return;
    }

    const scheduler = options.scheduler ?? browserScheduler;
    if (!options.live) await replayDrag(gesture, signal, scheduler, onPreview);

    throwIfAborted(signal);
    onPreview(preview(gesture, 1, "released"));
    await submit();

    throwIfAborted(signal);
    await scheduler.wait(RELEASE_HOLD, signal);
    onPreview(preview(gesture, 1, "settling"));
    await scheduler.wait(SETTLE_DURATION, signal);
  } finally {
    onPreview(null);
  }
}
