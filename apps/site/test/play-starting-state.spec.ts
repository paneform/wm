import { parseScenario } from "@paneform/layout-browser";
import { describe, expect, it } from "vitest";
import { emptyPlaygroundScenario } from "../src/lib/play/playground-defaults.js";
import { editStartingState, physicalWindow } from "../src/lib/play/playground-state.js";

describe("starting-layout editing", () => {
  it("adds authored windows to the selected display workspace, not an invisible default", () => {
    const state = {
      ...emptyPlaygroundScenario.state,
      focusedWorkspace: "T",
      topology: [{ ...emptyPlaygroundScenario.state.topology[0]!, workspace: "T" }],
    };
    const window = { id: "A", frame: { x: 40, y: 80, width: 500, height: 360 } };
    const result = editStartingState(state, { kind: "window_added", window }, "display:main");
    expect(result.windows[0]?.workspace).toBe("T");
    expect(result.windows[0]?.frame).toEqual(window.frame);
    expect(parseScenario({ state: result }).state.windows[0]?.workspace).toBe("T");
  });
  it("keeps assignment policy out of physical window events", () => {
    const window = {
      id: "A",
      workspace: "1",
      floating: true,
      frame: { x: 10, y: 20, width: 800, height: 600 },
      constraints: { maxWidth: 900 },
    };
    const event = { kind: "window_changed", window: physicalWindow(window) } as const;
    expect(event.window).not.toHaveProperty("workspace");
    expect(event.window).not.toHaveProperty("floating");
    expect(() =>
      parseScenario({
        state: { ...emptyPlaygroundScenario.state, windows: [window] },
        steps: [{ event }],
      }),
    ).not.toThrow();
  });

  it("edits exact starting frames without invoking the WM or clamping to bounds", () => {
    const window = {
      id: "A",
      workspace: "work",
      frame: { x: 0, y: 0, width: 800, height: 600 },
      constraints: { minWidth: 500 },
    };
    const initial = { ...emptyPlaygroundScenario.state, windows: [window], wmRunning: true };
    const state = editStartingState(initial, {
      kind: "window_changed",
      window: { id: "A", frame: { ...window.frame, width: 300 } },
    });
    expect(state.windows[0]).toMatchObject({
      workspace: "work",
      frame: { width: 300 },
      constraints: { minWidth: 500 },
    });
    expect(initial.windows[0]?.frame.width).toBe(800);
    expect(parseScenario({ state }).state.windows[0]?.frame.width).toBe(300);
  });
});
