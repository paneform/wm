import { describe, expect, it } from "vitest";
import { createScenarioSession } from "../src/scenario-runner.js";
import type { LayoutScenario } from "../src/scenario.js";

// Reduced from the shared 1 -> T -> 1 recording. Settings is physically
// present but unassigned, overlapping the already-tiled workspace at Start.
const reported: LayoutScenario = {
  config: {
    defaults: { mode: "bsp", gap: 0, margins: { top: 32 } },
    workspaces: [
      { name: "C", assign: [{ bundleId: "com.apple.systempreferences" }] },
      { name: "1" },
      { name: "T" },
    ],
  },
  state: {
    topology: [
      {
        id: "display:main",
        frame: { x: 0, y: 0, width: 1512, height: 982 },
        workArea: { x: 0, y: 44, width: 1512, height: 780 },
        workspace: "1",
      },
    ],
    windows: [
      { id: "Terminal", workspace: "T", frame: { x: -1511, y: 930, width: 1512, height: 748 } },
      { id: "Browser", workspace: "1", frame: { x: 378, y: 76, width: 1134, height: 748 } },
      { id: "Messages", workspace: "1", frame: { x: 0, y: 76, width: 378, height: 374 } },
      { id: "Music", workspace: "1", frame: { x: 0, y: 450, width: 189, height: 374 } },
      { id: "Contacts", workspace: "1", frame: { x: 189, y: 450, width: 189, height: 374 } },
      {
        id: "Settings",
        workspace: null,
        bundleId: "com.apple.systempreferences",
        constraints: { maxWidth: 723 },
        frame: { x: 0, y: 76, width: 723, height: 748 },
      },
    ],
    focusedWindow: "Browser",
    focusedWorkspace: "1",
    wmRunning: true,
  },
};

describe("reported workspace roundtrip", () => {
  it("identifies late admission of the unassigned Settings window in an old snapshot", async () => {
    const session = await createScenarioSession(reported);
    try {
      expect(
        (await session.snapshot()).windows.find(({ id }) => id === "Settings")?.workspace,
      ).toBeNull();
      await session.apply({ command: "workspace focus T" });
      const after = await session.apply({ command: "workspace focus 1" });
      expect(after.windows.find(({ id }) => id === "Settings")).toMatchObject({
        workspace: "1",
        frame: { x: 945, y: 76, width: 567, height: 748 },
      });
      expect(after.windows.find(({ id }) => id === "Browser")?.frame).toEqual({
        x: 378,
        y: 76,
        width: 567,
        height: 748,
      });
    } finally {
      await session.dispose();
    }
  });

  it("settles a recorded Settings launch before switching away and returning", async () => {
    const settings = reported.state.windows.find(({ id }) => id === "Settings")!;
    const session = await createScenarioSession({
      ...reported,
      state: {
        ...reported.state,
        windows: reported.state.windows.filter(({ id }) => id !== "Settings"),
      },
    });
    try {
      const { workspace: _workspace, ...physical } = settings;
      const settled = await session.apply({ event: { kind: "window_added", window: physical } });
      expect(settled.windows.find(({ id }) => id === "Settings")?.workspace).toBe("1");
      await session.apply({ command: "workspace focus T" });
      const returned = await session.apply({ command: "workspace focus 1" });
      expect(
        returned.windows.map(({ id, workspace, frame }) => ({ id, workspace, frame })),
      ).toEqual(settled.windows.map(({ id, workspace, frame }) => ({ id, workspace, frame })));
    } finally {
      await session.dispose();
    }
  });
});
