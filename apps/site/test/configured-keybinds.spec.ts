import { describe, expect, it } from "vitest";
import {
  configuredKeybindIssues,
  createModifierTracker,
  eventToConfiguredCommand,
} from "../src/lib/play/configured-keybinds.js";

const event = (code: string, init: Partial<KeyboardEvent> = {}) =>
  // SAFETY: The matcher reads only the complete KeyboardEvent fields supplied by this fixture.
  ({
    code,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    defaultPrevented: false,
    repeat: false,
    isComposing: false,
    ...init,
  }) as KeyboardEvent;

describe("configured keybinds", () => {
  it("normalizes native keys and aliases while matching modifiers exactly", () => {
    const binds = { "ctrl alt return": "service start" };
    expect(eventToConfiguredCommand(event("Enter", { ctrlKey: true, altKey: true }), binds)).toBe(
      "service start",
    );
    expect(
      eventToConfiguredCommand(
        event("Enter", { ctrlKey: true, altKey: true, shiftKey: true }),
        binds,
      ),
    ).toBeNull();
  });
  it("matches key codes rather than localized key values", () => {
    expect(
      eventToConfiguredCommand(event("KeyH", { shiftKey: true }), {
        "shift h": "window focus left",
      }),
    ).toBe("window focus left");
  });
  it("reports chords and actions that cannot replay", () => {
    expect(
      configuredKeybindIssues({
        "rshift h": "window focus left",
        "fn h": "window focus left",
        "shift j": "not-a-command",
      }),
    ).toEqual([
      expect.objectContaining({
        chord: "shift j",
        reason: "action is not a supported scenario command",
      }),
    ]);
  });

  it("matches rshift 1 only while right Shift is held", () => {
    const tracker = createModifierTracker();
    const bindings = { "rshift 1": "workspace focus 1" };
    const trigger = event("Digit1", { shiftKey: true });
    tracker.keydown(event("ShiftLeft", { shiftKey: true }));
    expect(eventToConfiguredCommand(trigger, bindings, tracker.pressed)).toBeNull();
    tracker.keyup(event("ShiftLeft"));
    tracker.keydown(event("ShiftRight", { shiftKey: true }));
    expect(eventToConfiguredCommand(trigger, bindings, tracker.pressed)).toBe("workspace focus 1");
    tracker.keyup(event("ShiftRight"));
    expect(eventToConfiguredCommand(event("Digit1"), bindings, tracker.pressed)).toBeNull();
  });

  it.each([
    { left: "ShiftLeft", right: "ShiftRight", generic: "shift", flag: "shiftKey" },
    { left: "ControlLeft", right: "ControlRight", generic: "control", flag: "ctrlKey" },
    { left: "AltLeft", right: "AltRight", generic: "option", flag: "altKey" },
    { left: "MetaLeft", right: "MetaRight", generic: "command", flag: "metaKey" },
  ] as const)(
    "distinguishes both $generic sides with native exact-match semantics",
    ({ left, right, generic, flag }) => {
      const tracker = createModifierTracker();
      const trigger = event("KeyH", { [flag]: true });
      const command = "window focus left";
      const matches = (chord: string) =>
        eventToConfiguredCommand(trigger, { [chord]: command }, tracker.pressed);
      tracker.keydown(event(left, { [flag]: true }));
      expect(matches(`l${generic} h`)).toBe(command);
      expect(matches(`r${generic} h`)).toBeNull();
      expect(matches(`${generic} h`)).toBe(command);
      tracker.keydown(event(right, { [flag]: true }));
      expect(matches(`l${generic} h`)).toBeNull();
      expect(matches(`r${generic} h`)).toBeNull();
      expect(matches(`l${generic} r${generic} h`)).toBe(command);
      expect(matches(`${generic} h`)).toBe(command);
      tracker.keyup(event(left, { [flag]: true }));
      expect(matches(`r${generic} h`)).toBe(command);
    },
  );

  it("combines sided and generic modifier groups without allowing extra modifiers", () => {
    const tracker = createModifierTracker();
    tracker.keydown(event("ShiftRight", { shiftKey: true }));
    tracker.keydown(event("AltLeft", { shiftKey: true, altKey: true }));
    const bindings = { "rshift alt 1": "workspace move-window 1" };
    expect(
      eventToConfiguredCommand(
        event("Digit1", { shiftKey: true, altKey: true }),
        bindings,
        tracker.pressed,
      ),
    ).toBe("workspace move-window 1");
    expect(
      eventToConfiguredCommand(
        event("Digit1", { shiftKey: true, altKey: true, ctrlKey: true }),
        bindings,
        tracker.pressed,
      ),
    ).toBeNull();
  });

  it("uses location if a modifier code is absent and clears stale state", () => {
    const tracker = createModifierTracker();
    tracker.keydown(event("", { key: "Shift", location: 2, shiftKey: true }));
    expect(tracker.pressed.has("ShiftRight")).toBe(true);
    tracker.reset();
    expect(tracker.pressed.size).toBe(0);
    // Aggregate Shift alone must not guess a side after focus was lost.
    expect(
      eventToConfiguredCommand(
        event("Digit1", { shiftKey: true }),
        { "rshift 1": "workspace focus 1" },
        tracker.pressed,
      ),
    ).toBeNull();
    tracker.keydown(event("ShiftRight", { shiftKey: true }));
    tracker.keydown(event("KeyA"));
    expect(tracker.pressed.size).toBe(0);
  });

  it("rejects ambiguous generic-plus-sided modifiers and duplicates", () => {
    expect(
      configuredKeybindIssues({
        "shift rshift 1": "workspace focus 1",
        "rshift rshift 2": "workspace focus 2",
      }),
    ).toHaveLength(2);
  });

  it("matches Fn when exposed by an event or modifier state", () => {
    const tracker = createModifierTracker();
    const bindings = { "fn h": "window focus left" };
    tracker.keydown(event("Fn"));
    expect(eventToConfiguredCommand(event("KeyH"), bindings, tracker.pressed)).toBe(
      "window focus left",
    );
    tracker.keyup(event("Fn"));
    expect(eventToConfiguredCommand(event("KeyH"), bindings, tracker.pressed)).toBeNull();
    expect(
      eventToConfiguredCommand(
        event("KeyH", { getModifierState: (name) => name === "Fn" }),
        bindings,
        tracker.pressed,
      ),
    ).toBe("window focus left");
  });
  it("uses fallback hero focus bindings only when keybinds are absent", () => {
    expect(eventToConfiguredCommand(event("KeyL", { shiftKey: true }), undefined)).toBe(
      "window focus right",
    );
    expect(eventToConfiguredCommand(event("ArrowRight", { shiftKey: true }), undefined)).toBe(
      "window focus right",
    );
    expect(eventToConfiguredCommand(event("KeyL", { shiftKey: true }), {})).toBeNull();
    expect(eventToConfiguredCommand(event("ArrowRight", { shiftKey: true }), {})).toBeNull();
  });
});
