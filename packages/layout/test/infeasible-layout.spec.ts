import { describe, expect, test } from "vitest";
import { clampToCapabilities } from "../src/rules/clamp-to-capabilities.ts";
import { reconcileDrift } from "../src/rules/reconcile-drift.ts";
import { tileWorkspaces } from "../src/rules/tile-workspaces.ts";
import type { RuleContext } from "../src/rules/rule.ts";
import type { WindowObservation } from "../src/schema.ts";
import type { BspNode, World, WorkspaceState } from "../src/world.ts";
import { makeDisplay } from "./helpers/fake-platform.ts";

const frame = (x: number, width: number) => ({ x, y: 32, width, height: 950 });

const window = (id: string, minWidth: number, x: number, width: number): WindowObservation => ({
  id,
  pid: minWidth,
  bundleId: `test.${id}`,
  role: "AXWindow",
  frame: frame(x, width),
  minimized: false,
  hidden: false,
  fullscreen: false,
  focused: id === "chatgpt",
  capabilities: {
    movable: "supported",
    resizable: "supported",
    movableEvidence: "platform_report",
    resizableEvidence: "platform_report",
  },
  constraints: { minWidth },
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

const tree: BspNode = {
  kind: "split",
  axis: "vertical",
  ratio: 0.5,
  first: { kind: "leaf", windowId: "spotify" },
  second: {
    kind: "split",
    axis: "vertical",
    ratio: 0.5,
    first: { kind: "leaf", windowId: "docker" },
    second: { kind: "leaf", windowId: "chatgpt" },
  },
};

const workspace = (): WorkspaceState => ({
  name: "1",
  mode: "bsp",
  tree,
  floating: new Set(),
  visibleOnDisplay: "display:sim-primary",
  preferredDisplay: null,
  pinnedDisplayOverride: null,
  parkedFrames: new Map(),
  lastFocusedMember: "chatgpt",
});

const world = (settled = false): World => {
  const spotify = window("spotify", 800, 0, 800);
  const docker = window("docker", 940, settled ? 572 : 756, 940);
  const chatgpt = window("chatgpt", 480, settled ? 1032 : 1134, 480);
  return {
    topology: {
      displays: [
        makeDisplay({
          frame: frame(0, 1512),
          workArea: frame(0, 1512),
        }),
      ],
    },
    windows: new Map([
      [spotify.id, spotify],
      [docker.id, docker],
      [chatgpt.id, chatgpt],
    ]),
    workspaces: new Map([["1", workspace()]]),
    focusedWorkspace: "1",
    profiles: new Map(),
    parkingFacts: [],
    paused: false,
    epoch: 0,
    focusIntent: { id: "chatgpt", generation: 1 },
  };
};

describe("infeasible learned minimum-size fallback", () => {
  test("selects contained overlap without floating any BSP member", () => {
    const current = world();
    const actions = tileWorkspaces.run(current, context);

    expect(clampToCapabilities.run(current, context)).toEqual([]);
    expect(actions).toEqual([
      { kind: "setFrame", windowId: "docker", frame: frame(572, 940) },
      { kind: "setFrame", windowId: "chatgpt", frame: frame(1032, 480) },
    ]);
    expect(reconcileDrift.run(current, context)).toEqual(actions);
    expect(actions.some((action) => action.kind === "floatWindow")).toBe(false);
  });

  test("emits zero writes after overlap settles and preserves focus intent", () => {
    const settled = world(true);

    expect(clampToCapabilities.run(settled, context)).toEqual([]);
    expect(tileWorkspaces.run(settled, context)).toEqual([]);
    expect(reconcileDrift.run(settled, context)).toEqual([]);
    expect(settled.focusedWorkspace).toBe("1");
    expect(settled.focusIntent).toEqual({ id: "chatgpt", generation: 1 });
  });
});
