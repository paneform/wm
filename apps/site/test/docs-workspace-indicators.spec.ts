import {
  createScenarioSession,
  type LayoutScenario,
  type SimulationState,
} from "@paneform/layout-browser";
import { describe, expect, it } from "vitest";
import { parseDocsScenario } from "../src/lib/docs/demo-data.js";
import { scenarioFiles } from "../src/lib/docs/scenario-files.js";
import { workspaceIndicators } from "../src/lib/docs/workspace-indicators.js";

const example = parseDocsScenario(scenarioFiles["workspace-next-display.json"]);

describe("workspace indicator ownership", () => {
  it.each(["workspace-next-display.json", "workspace-move-display.json"] as const)(
    "moves one indicator between displays for %s",
    async (file) => {
      const scenario = parseDocsScenario(scenarioFiles[file]);
      const session = await createScenarioSession(scenario);
      try {
        expect(workspaceIndicators(scenario, await session.snapshot())).toEqual([
          { windowId: "focused-window", workspace: "1", displayId: "display:main" },
        ]);
        const result = await session.step();
        expect(workspaceIndicators(scenario, result!.state)).toEqual([
          { windowId: "focused-window", workspace: "1", displayId: "display:second" },
        ]);
      } finally {
        await session.dispose();
      }
    },
  );

  it("assigns parked workspace members once using their preferred display", () => {
    const scenario: LayoutScenario = {
      ...example,
      config: { workspaces: [{ name: "writing", preferredDisplay: "display:second" }] },
    };
    const state: SimulationState = {
      ...example.state,
      windows: [
        ...example.state.windows,
        {
          id: "parked-window",
          workspace: "writing",
          frame: { x: -639, y: 848, width: 640, height: 400 },
        },
      ],
    };
    expect(workspaceIndicators(scenario, state)).toEqual([
      { windowId: "focused-window", workspace: "1", displayId: "display:main" },
      { windowId: "parked-window", workspace: "writing", displayId: "display:second" },
    ]);
  });

  it("uses a physical display while stopped, even if workspace assignment differs", () => {
    const state: SimulationState = {
      ...example.state,
      wmRunning: false,
      windows: example.state.windows.map((window) => ({
        ...window,
        frame: { ...window.frame, x: 1440 },
      })),
    };
    expect(workspaceIndicators(example, state)).toEqual([
      { windowId: "focused-window", workspace: "1", displayId: "display:second" },
    ]);
  });

  it("defaults omitted membership to 1 and excludes unassigned windows", () => {
    const { workspace: _membership, ...window } = example.state.windows[0]!;
    const state: SimulationState = {
      ...example.state,
      windows: [window, { ...window, id: "unmanaged", workspace: null }],
    };
    expect(workspaceIndicators(example, state)).toEqual([
      { windowId: "focused-window", workspace: "1", displayId: "display:main" },
    ]);
  });

  it("keeps hidden members on their initial display when no preference exists", () => {
    const state: SimulationState = {
      ...example.state,
      topology: example.state.topology.map((display) => ({ ...display, workspace: null })),
    };
    expect(workspaceIndicators(example, state)).toEqual([
      { windowId: "focused-window", workspace: "1", displayId: "display:main" },
    ]);
  });
});
