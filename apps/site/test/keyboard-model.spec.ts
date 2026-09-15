import { describe, expect, it } from "vitest";

import {
  heroKeyboardChords,
  keyboardKeys,
  primaryKeyboardChord,
  tokens,
} from "$lib/design/tokens.js";
import { shortcutReadoutKeyIds, sortShortcutKeys } from "$lib/hero/shortcut-key-order.js";
import { HERO_WORKSPACES } from "$lib/hero/workspace-model.js";

describe("canonical keyboard model", () => {
  it("orders shortcut keys independently of press order", () => {
    const byId = new Map(keyboardKeys.map((key) => [key.id, key]));
    const keys = ["slash", "z", "0", "space", "rshift", "command-right", "lshift"]
      .map((id) => byId.get(id))
      .filter((key): key is (typeof keyboardKeys)[number] => Boolean(key));

    expect(sortShortcutKeys(keys, keyboardKeys).map(({ id }) => id)).toEqual([
      "lshift",
      "command-right",
      "rshift",
      "space",
      "0",
      "z",
      "slash",
    ]);
  });

  it("shows canonical chord keys while preserving raw keys for partial input", () => {
    const chord = primaryKeyboardChord(heroKeyboardChords, {
      type: "focusDirection",
      direction: "left",
    })!;
    const physicalAlias = new Set(["rshift", "h"] as const);

    expect(shortcutReadoutKeyIds(physicalAlias, chord, null)).toEqual(["rshift", "arrow-left"]);
    expect(shortcutReadoutKeyIds(physicalAlias, null, chord)).toEqual(["rshift", "arrow-left"]);
    expect(shortcutReadoutKeyIds(new Set(["rshift"]), null, null)).toEqual(["rshift"]);
    expect(shortcutReadoutKeyIds(new Set(), null, chord)).toEqual(["rshift", "arrow-left"]);
  });

  it("contains the complete ANSI matrix and unique physical mappings", () => {
    expect(keyboardKeys).toHaveLength(78);
    expect(new Set(keyboardKeys.map((key) => key.id)).size).toBe(keyboardKeys.length);
    const codes = keyboardKeys.flatMap((key) => (key.code ? [key.code] : []));
    expect(new Set(codes).size).toBe(codes.length);
    expect(keyboardKeys.find((key) => key.id === "touch-id")?.code).toBeNull();
    expect(keyboardKeys.filter((key) => key.row === 0)).toHaveLength(14);
  });

  it("models distinct modifiers and inverted-T half-height arrows", () => {
    expect(keyboardKeys.find((key) => key.id === "lshift")?.code).toBe("ShiftLeft");
    expect(keyboardKeys.find((key) => key.id === "rshift")?.code).toBe("ShiftRight");
    const left = keyboardKeys.find((key) => key.id === "arrow-left")!;
    const up = keyboardKeys.find((key) => key.id === "arrow-up")!;
    const down = keyboardKeys.find((key) => key.id === "arrow-down")!;
    const right = keyboardKeys.find((key) => key.id === "arrow-right")!;
    const arrows = [left, up, down, right];
    expect(up.x).toBe(down.x);
    expect(arrows.every((key) => key.height === 0.5)).toBe(true);
    expect(left.y).toBe(down.y);
    expect(right.y).toBe(down.y);
    expect(down.y).toBeGreaterThan(up.y);
    expect(up.y + up.height).toBe(down.y);
    expect(arrows.map((key) => key.legend)).toEqual(["◀", "▲", "▼", "▶"]);
  });

  it("uses a full-height function row and an unlabelled Touch ID key", () => {
    const functionKeys = keyboardKeys.filter((key) => key.row === 0);
    expect(functionKeys.every((key) => key.height === tokens.keyboard.unit)).toBe(true);
    const touchId = functionKeys.find((key) => key.id === "touch-id");
    expect(touchId?.legend).toBe("");
    expect(touchId?.alternateLegend).toBeUndefined();
  });

  it("uses lowercase named keys and Mac modifier symbols", () => {
    expect(keyboardKeys.find((key) => key.id === "escape")?.legend).toBe("esc");
    expect(keyboardKeys.find((key) => key.id === "tab")?.legend).toBe("tab");
    expect(keyboardKeys.find((key) => key.id === "return")?.legend).toBe("return");
    expect(keyboardKeys.find((key) => key.id === "delete")?.legend).toBe("delete");
    expect(keyboardKeys.find((key) => key.id === "control-left")?.legend).toBe("⌃");
    expect(keyboardKeys.find((key) => key.id === "option-left")?.legend).toBe("⌥");
    expect(keyboardKeys.find((key) => key.id === "command-left")?.legend).toBe("⌘");
    expect(keyboardKeys.find((key) => key.id === "lshift")?.legend).toBe("shift");
    expect(keyboardKeys.find((key) => key.id === "rshift")?.legend).toBe("shift");
    expect(keyboardKeys.find((key) => key.id === "lshift")?.alternateLegend).toBeUndefined();
    expect(keyboardKeys.find((key) => key.id === "rshift")?.alternateLegend).toBeUndefined();
    expect(tokens.keyboard.shiftLabelSize).toBe(tokens.keyboard.labelSize);
    expect(keyboardKeys.find((key) => key.id === "a")?.legend).toBe("A");
  });

  it("pairs number keys with their ANSI shifted symbols", () => {
    const numbers = keyboardKeys.filter((key) => key.code?.startsWith("Digit"));
    expect(numbers.map((key) => key.legend).join("")).toBe("1234567890");
    expect(numbers.map((key) => key.alternateLegend).join("")).toBe("!@#$%^&*()");
  });

  it("keeps every cap inside the tokenized keyboard bed", () => {
    for (const key of keyboardKeys) {
      expect(key.x).toBeGreaterThanOrEqual(0);
      expect(key.x + key.width).toBeLessThanOrEqual(tokens.keyboard.bedWidth + 1e-10);
      expect(key.y + key.height).toBeLessThanOrEqual(tokens.keyboard.bedHeight);
    }
  });

  it("centers each row and follows the supplied unit sizing", () => {
    for (let row = 0; row < 6; row += 1) {
      const rowKeys = keyboardKeys.filter((key) => key.row === row);
      const leftInset = Math.min(...rowKeys.map((key) => key.x));
      const rightEdge = Math.max(...rowKeys.map((key) => key.x + key.width));
      expect(leftInset).toBeCloseTo(tokens.keyboard.bedWidth - rightEdge);
    }

    const keyWidth = (id: string) => keyboardKeys.find((key) => key.id === id)!.width;
    const scaledWidth = (units: number) => units + (units - 1) * tokens.keyboard.gap;
    const control = keyboardKeys.find((key) => key.id === "control-left")!;
    const leftOption = keyboardKeys.find((key) => key.id === "option-left")!;
    const leftCommand = keyboardKeys.find((key) => key.id === "command-left")!;
    const rightCommand = keyboardKeys.find((key) => key.id === "command-right")!;
    const rightOption = keyboardKeys.find((key) => key.id === "option-right")!;
    expect(leftOption.width).toBe(control.width);
    expect(rightOption.width).toBe(leftOption.width);
    expect(rightCommand.width).toBe(leftCommand.width);
    expect(keyWidth("escape")).toBe(scaledWidth(1.5));
    expect(keyWidth("f1")).toBe(1);
    expect(keyWidth("delete")).toBe(scaledWidth(1.5));
    expect(keyWidth("tab")).toBe(scaledWidth(1.5));
    expect(keyWidth("caps-lock")).toBe(scaledWidth(1.75));
    expect(keyWidth("return")).toBe(scaledWidth(1.75));
    expect(keyWidth("lshift")).toBe(scaledWidth(2.25));
    expect(keyWidth("rshift")).toBe(scaledWidth(2.25));
    expect(keyWidth("command-left")).toBe(scaledWidth(1.25));
    expect(keyWidth("space")).toBe(scaledWidth(5));
    expect(keyWidth("a")).toBe(1);
  });

  it("defines directional and workspace chords in the registry", () => {
    const directionalIds = [
      "move-left",
      "focus-left",
      "move-down",
      "focus-down",
      "move-up",
      "focus-up",
      "move-right",
      "focus-right",
    ];
    expect(heroKeyboardChords.filter(({ primary }) => primary).map(({ id }) => id)).toEqual(
      directionalIds,
    );
    expect(
      primaryKeyboardChord(heroKeyboardChords, { type: "focusDirection", direction: "left" })?.keys,
    ).toEqual(["rshift", "arrow-left"]);
    expect(heroKeyboardChords.find(({ id }) => id === "focus-left-hjkl")?.keys).toEqual([
      "rshift",
      "h",
    ]);
    for (const workspace of HERO_WORKSPACES) {
      const key = workspace.toLowerCase();
      expect(heroKeyboardChords).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: `move-window-${key}`,
            keys: ["lshift", "rshift", key],
            command: { type: "moveFocusedWindowToWorkspace", workspace },
          }),
          expect.objectContaining({
            id: `focus-workspace-${key}`,
            keys: ["rshift", key],
            command: { type: "focusWorkspace", workspace },
          }),
        ]),
      );
    }
    expect(heroKeyboardChords.at(-1)?.id).toBe("move-workspace-display");
    expect(new Set(heroKeyboardChords.map(({ id }) => id)).size).toBe(heroKeyboardChords.length);
    expect(heroKeyboardChords).toHaveLength(16 + HERO_WORKSPACES.length * 2 + 1);
    expect(tokens.motion.commandReadout).toBe(1500);
    expect(heroKeyboardChords.find(({ id }) => id === "move-window-z")?.readout).toBe(
      "move window workspace Z",
    );
    expect(heroKeyboardChords.find(({ id }) => id === "focus-workspace-0")?.readout).toBe(
      "focus workspace 0",
    );
  });
});
