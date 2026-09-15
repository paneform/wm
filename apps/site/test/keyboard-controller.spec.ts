import { describe, expect, it, vi } from "vitest";

import { heroKeyboardChords, keyboardKeys } from "$lib/design/tokens.js";
import {
  browserKeyboardScheduler,
  createKeyboardController,
  type KeyboardScheduler,
} from "$lib/hero/keyboard-controller.js";

class ManualScheduler implements KeyboardScheduler {
  waits: Array<{ resolve: () => void; reject: (reason: string | undefined) => void }> = [];

  wait(_duration: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const wait = { resolve, reject };
      this.waits.push(wait);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }

  resolveNext() {
    this.waits.shift()?.resolve();
  }
}

class Stage extends EventTarget {
  root = new EventTarget();
  ownerDocument = { defaultView: this.root };
}

function event(
  type: string,
  code: string,
  options: {
    repeat?: boolean;
    composing?: boolean;
    key?: string;
    location?: number;
    modifierActive?: boolean;
  } = {},
) {
  // SAFETY: The test defines every KeyboardEvent field consumed by the controller below.
  const value = new Event(type, { cancelable: true }) as Event & Partial<KeyboardEvent>;
  Object.defineProperties(value, {
    code: { value: code },
    repeat: { value: options.repeat ?? false },
    isComposing: { value: options.composing ?? false },
    key: { value: options.key ?? "" },
    location: { value: options.location ?? 0 },
    getModifierState: { value: () => options.modifierActive ?? false },
  });
  return value;
}

function setup(
  scheduler: KeyboardScheduler = { wait: () => Promise.resolve() },
  scopeToStage = false,
) {
  const dispatch = vi.fn();
  const controller = createKeyboardController({
    layout: keyboardKeys,
    chords: heroKeyboardChords,
    scheduler,
    dispatch,
    scopeToStage,
  });
  return { controller, dispatch };
}

describe("keyboard controller", () => {
  it("removes scheduler abort listeners after resolution and cancellation", async () => {
    vi.useFakeTimers();
    const scheduler = browserKeyboardScheduler();
    const resolvedSignal = new AbortController();
    const resolvedRemove = vi.spyOn(resolvedSignal.signal, "removeEventListener");
    const resolved = scheduler.wait(10, resolvedSignal.signal);
    await vi.advanceTimersByTimeAsync(10);
    await resolved;
    expect(resolvedRemove).toHaveBeenCalledOnce();

    const abortedSignal = new AbortController();
    const abortedRemove = vi.spyOn(abortedSignal.signal, "removeEventListener");
    const aborted = scheduler.wait(10, abortedSignal.signal);
    abortedSignal.abort("stop");
    await expect(aborted).rejects.toBe("stop");
    expect(abortedRemove).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("tracks source ownership as a union and releases sources independently", () => {
    const { controller } = setup();
    controller.press({ key: "lshift", source: "script" });
    controller.press({ key: "lshift", source: "user" });
    controller.press({ key: "lshift", source: "user" });
    controller.releaseAll({ source: "script" });
    expect(controller.state.pressed.has("lshift")).toBe(true);
    controller.release({ key: "lshift", source: "user" });
    controller.release({ key: "lshift", source: "user" });
    expect(controller.state.pressed.size).toBe(0);
  });

  it("releases only keys acquired by an aborted timed chord", async () => {
    const scheduler = new ManualScheduler();
    const { controller } = setup(scheduler);
    controller.press({ key: "lshift", source: "user" });
    const abort = new AbortController();
    const operation = controller.chord({
      keys: ["lshift", "rshift", "m"],
      preHold: 1,
      hold: 1,
      source: "script",
      signal: abort.signal,
    });
    abort.abort("stop");
    await expect(operation).rejects.toBe("stop");
    expect(controller.state.userPressed.has("lshift")).toBe(true);
    expect(controller.state.scriptPressed.size).toBe(0);
  });

  it("holds the full chord until the committed command acknowledgment", async () => {
    const scheduler = new ManualScheduler();
    const { controller } = setup(scheduler);
    let acknowledge = () => {};
    const committed = new Promise<void>((resolve) => (acknowledge = resolve));
    const triggered = vi.fn(() => committed);
    const operation = controller.chord({
      keys: ["lshift", "rshift", "m"],
      pressStagger: 140,
      preHold: 210,
      hold: 1500,
      source: "script",
      onTrigger: triggered,
    });

    expect([...controller.state.scriptPressed]).toEqual(["lshift"]);
    scheduler.resolveNext();
    await Promise.resolve();
    expect([...controller.state.scriptPressed]).toEqual(["lshift", "rshift"]);
    scheduler.resolveNext();
    await Promise.resolve();
    expect([...controller.state.scriptPressed]).toEqual(["lshift", "rshift", "m"]);
    expect(triggered).toHaveBeenCalledOnce();
    expect(scheduler.waits).toHaveLength(0);

    acknowledge();
    await Promise.resolve();
    expect(scheduler.waits).toHaveLength(1);
    expect(controller.state.scriptPressed.has("m")).toBe(true);
    scheduler.resolveNext();
    await operation;
    expect(controller.state.scriptPressed.size).toBe(0);
  });

  it("captures unfocused window keys, maps sides, and requires exact modifiers", () => {
    const { controller, dispatch } = setup();
    const stage = new Stage();
    controller.attach(stage);
    stage.root.dispatchEvent(event("keydown", "ShiftLeft"));
    stage.root.dispatchEvent(event("keydown", "ShiftRight"));
    const trigger = event("keydown", "KeyM");
    stage.root.dispatchEvent(trigger);
    stage.root.dispatchEvent(event("keydown", "KeyM", { repeat: true }));
    expect(trigger.defaultPrevented).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);

    stage.root.dispatchEvent(event("keyup", "KeyM"));
    stage.root.dispatchEvent(event("keydown", "ControlLeft"));
    stage.root.dispatchEvent(event("keydown", "KeyM"));
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("limits keyboard capture to the supplied stage when requested", () => {
    const { controller, dispatch } = setup(undefined, true);
    const stage = new Stage();
    controller.attach(stage);

    stage.root.dispatchEvent(event("keydown", "ShiftLeft"));
    expect(controller.state.userPressed.size).toBe(0);

    stage.dispatchEvent(event("keydown", "ShiftLeft"));
    stage.dispatchEvent(event("keydown", "ShiftRight"));
    stage.dispatchEvent(event("keydown", "KeyM"));
    expect(dispatch).toHaveBeenCalledOnce();

    stage.root.dispatchEvent(new Event("blur"));
    expect(controller.state.userPressed.size).toBe(0);
  });

  it("releases stage-owned keys when keyup occurs outside the stage", () => {
    const { controller, dispatch } = setup(undefined, true);
    const stage = new Stage();
    controller.attach(stage);

    stage.dispatchEvent(event("keydown", "ShiftRight", { key: "Shift", location: 2 }));
    expect(controller.state.userPressed).toEqual(new Set(["rshift"]));

    const release = event("keyup", "ShiftRight", { key: "Shift", location: 2 });
    stage.root.dispatchEvent(release);
    expect(release.defaultPrevented).toBe(false);
    expect(controller.state.userPressed.size).toBe(0);

    stage.dispatchEvent(event("keydown", "KeyL"));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("uses modifier location when Safari reports the wrong Shift code", () => {
    const { controller } = setup();
    const stage = new Stage();
    controller.attach(stage);
    stage.root.dispatchEvent(event("keydown", "ShiftLeft", { key: "Shift", location: 1 }));
    stage.root.dispatchEvent(
      event("keydown", "ShiftRight", {
        key: "Shift",
        location: 2,
      }),
    );
    stage.root.dispatchEvent(event("keyup", "ShiftLeft", { key: "Shift", location: 2 }));

    expect(controller.state.userPressed).toEqual(new Set(["lshift"]));
  });

  it("clears a Safari modifier pair when the family is finally released", () => {
    vi.stubGlobal("navigator", { userAgent: "Version/18.0 Safari/605.1.15" });
    const { controller } = setup();
    const stage = new Stage();
    controller.attach(stage);
    stage.root.dispatchEvent(event("keydown", "AltLeft", { key: "Alt", location: 1 }));
    stage.root.dispatchEvent(event("keydown", "AltRight", { key: "Alt", location: 2 }));
    stage.root.dispatchEvent(
      event("keyup", "AltRight", { key: "Alt", location: 2, modifierActive: false }),
    );

    expect(controller.state.userPressed.size).toBe(0);
    vi.unstubAllGlobals();
  });

  it("publishes command completion only after dispatch succeeds", async () => {
    let complete = () => {};
    const dispatch = vi.fn(() => new Promise<void>((resolve) => (complete = resolve)));
    const controller = createKeyboardController({
      layout: keyboardKeys,
      chords: heroKeyboardChords,
      scheduler: { wait: () => Promise.resolve() },
      dispatch,
    });

    controller.press({ key: "lshift" });
    controller.press({ key: "rshift" });
    controller.press({ key: "m" });
    expect(controller.state.completedCommand).toBeNull();

    complete();
    await Promise.resolve();
    expect(controller.state.completedCommand?.chord.id).toBe("move-window-m");
    expect(controller.state.completedCommand?.sequence).toBe(1);
  });

  it("prevents Tab only for the exact registered chord", () => {
    const { controller } = setup();
    const stage = new Stage();
    controller.attach(stage);
    const loneTab = event("keydown", "Tab");
    stage.root.dispatchEvent(loneTab);
    expect(loneTab.defaultPrevented).toBe(false);
    stage.root.dispatchEvent(event("keyup", "Tab"));
    stage.root.dispatchEvent(event("keydown", "ShiftLeft"));
    stage.root.dispatchEvent(event("keydown", "ShiftRight"));
    const chordTab = event("keydown", "Tab");
    stage.root.dispatchEvent(chordTab);
    expect(chordTab.defaultPrevented).toBe(true);
  });

  it("ignores composition and already-prevented events", () => {
    const { controller } = setup();
    const stage = new Stage();
    controller.attach(stage);
    stage.root.dispatchEvent(event("keydown", "ShiftLeft", { composing: true }));
    const prevented = event("keydown", "ShiftRight");
    prevented.preventDefault();
    stage.root.dispatchEvent(prevented);
    expect(controller.state.pressed.size).toBe(0);
  });

  it("handles Escape, blur, pagehide, and idempotent attachment cleanup", () => {
    const onGlobalRelease = vi.fn();
    const controller = createKeyboardController({
      layout: keyboardKeys,
      chords: heroKeyboardChords,
      scheduler: { wait: () => Promise.resolve() },
      dispatch: vi.fn(),
      onGlobalRelease,
    });
    const stage = new Stage();
    const detach = controller.attach(stage);
    expect(controller.attach(stage)).toBe(detach);
    stage.root.dispatchEvent(event("keydown", "ShiftLeft"));
    stage.root.dispatchEvent(event("keydown", "Escape"));
    expect(controller.state.pressed.size).toBe(0);
    stage.root.dispatchEvent(event("keydown", "ShiftRight"));
    stage.root.dispatchEvent(new Event("blur"));
    expect(controller.state.userPressed.size).toBe(0);
    expect(onGlobalRelease).toHaveBeenCalledOnce();
    controller.press({ key: "m", source: "script" });
    stage.root.dispatchEvent(new Event("pagehide"));
    expect(onGlobalRelease).toHaveBeenCalledTimes(2);
    expect(controller.state.pressed.size).toBe(0);
    detach();
    detach();
    stage.root.dispatchEvent(event("keydown", "ShiftLeft"));
    expect(controller.state.pressed.size).toBe(0);
  });
});
