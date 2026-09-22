import { runScenario } from "@paneform/layout-browser";
import { describe, expect, it } from "vitest";
import { generatedHeroState } from "../src/lib/hero/generated-hero-state.js";
import { heroScenarioDocument } from "../src/lib/play/hero-scenario.js";

describe("generated hero state", () => {
  it("matches the hero scenario's final state", async () => {
    const finalState = await runScenario(JSON.parse(heroScenarioDocument));
    expect(generatedHeroState).toEqual(finalState);
  });

  it("shows the demo's closing picture", () => {
    expect(generatedHeroState.wmRunning).toBe(true);
    expect(generatedHeroState.focusedWorkspace).toBe("W");
    expect(generatedHeroState.focusedWindow).toBe("settings");
    const workspaces = new Map(
      generatedHeroState.windows.map((window) => [window.id, window.workspace]),
    );
    expect(workspaces).toEqual(
      new Map([
        ["terminal", "T"],
        ["browser", "1"],
        ["editor", "1"],
        ["waitlist", "W"],
        ["settings", "W"],
      ]),
    );
  });
});
