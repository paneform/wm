import { describe, expect, test } from "vitest";
import { parkInvisibleWorkspaces } from "../src/rules/park-invisible-workspaces.ts";
import { revealFocusedWorkspace } from "../src/rules/reveal-focused-workspace.ts";
import type { RuleContext } from "../src/rules/rule.ts";
import type { WindowObservation } from "../src/schema.ts";
import type { World, WorkspaceState } from "../src/world.ts";
import { makeDisplay } from "./helpers/fake-platform.ts";

const window = (id: string, x: number): WindowObservation => ({
  id,
  pid: 100,
  bundleId: "app.zen-browser.zen",
  title: "Zen",
  role: "AXWindow",
  frame: { x, y: 100, width: 800, height: 600 },
  minimized: false,
  hidden: false,
  fullscreen: false,
  focused: true,
  capabilities: {
    movable: "supported",
    resizable: "supported",
    movableEvidence: "platform_report",
    resizableEvidence: "platform_report",
  },
});

const workspace = (
  name: string,
  windowId: string,
  visibleOnDisplay: string | null,
  preferredDisplay: string | null = null,
): WorkspaceState => ({
  name,
  mode: "bsp",
  tree: { kind: "leaf", windowId },
  floating: new Set(),
  visibleOnDisplay,
  preferredDisplay,
  pinnedDisplayOverride: null,
  parkedFrames: new Map(),
  lastFocusedMember: windowId,
});

const context: RuleContext = {
  config: {},
  now: 0,
  tombstones: new Map(),
  overrides: { managed: new Set(), unmanaged: new Set() },
  contextFingerprint: "test",
  settings: (name) => ({
    name,
    mode: "bsp",
    gap: 0,
    resizeIncrement: 0.05,
    margins: { top: 0, right: 0, bottom: 0, left: 0 },
    preferredDisplay: null,
    assign: [],
  }),
  globalSettings: () => ({
    name: "",
    mode: "bsp",
    gap: 0,
    resizeIncrement: 0.05,
    margins: { top: 0, right: 0, bottom: 0, left: 0 },
    preferredDisplay: null,
    assign: [],
  }),
};

describe("workspace visibility reconciliation", () => {
  test("reveals an invisible focused workspace without parking it first", () => {
    const zen = window("zen", 100);
    const focused = workspace("web", zen.id, null, "display:sim-primary");
    const world: World = {
      topology: { displays: [makeDisplay()] },
      windows: new Map([[zen.id, zen]]),
      workspaces: new Map([[focused.name, focused]]),
      focusedWorkspace: focused.name,
      profiles: new Map(),
      parkingFacts: [],
      paused: false,
      epoch: 0,
      focusIntent: null,
    };

    expect(parkInvisibleWorkspaces.run(world, context)).toEqual([]);
    expect(revealFocusedWorkspace.run(world, context)).toEqual([
      { kind: "revealWorkspace", workspace: "web", displayId: "display:sim-primary" },
    ]);
  });

  test("does not relocate an already-visible focused workspace to its preferred display", () => {
    const zen = window("zen", -1200);
    const focused = workspace("web", zen.id, "display:sim-left", "display:sim-primary");
    const world: World = {
      topology: {
        displays: [
          makeDisplay(),
          makeDisplay({
            id: "display:sim-left",
            frame: { x: -1512, y: 0, width: 1512, height: 982 },
            workArea: { x: -1512, y: 38, width: 1512, height: 944 },
          }),
        ],
      },
      windows: new Map([[zen.id, zen]]),
      workspaces: new Map([[focused.name, focused]]),
      focusedWorkspace: focused.name,
      profiles: new Map(),
      parkingFacts: [],
      paused: false,
      epoch: 0,
      focusIntent: null,
    };

    expect(revealFocusedWorkspace.run(world, context)).toEqual([]);
  });

  test("falls back to a connected display when the preferred display is absent", () => {
    const zen = window("zen", -1200);
    const focused = workspace("web", zen.id, null, "display:disconnected");
    const world: World = {
      topology: { displays: [makeDisplay()] },
      windows: new Map([[zen.id, zen]]),
      workspaces: new Map([[focused.name, focused]]),
      focusedWorkspace: focused.name,
      profiles: new Map(),
      parkingFacts: [],
      paused: false,
      epoch: 0,
      focusIntent: null,
    };

    expect(revealFocusedWorkspace.run(world, context)).toEqual([
      { kind: "revealWorkspace", workspace: "web", displayId: "display:sim-primary" },
    ]);
  });
});
