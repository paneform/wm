import { createScenarioSession } from "@paneform/layout-browser";
import { describe, expect, it } from "vitest";
import { heroScenarioDocument, parseHeroScenario } from "../src/lib/play/hero-scenario.js";

describe("hero play scenario", () => {
  it("keeps the displayed source as valid, parseable scenario JSON", () => {
    const source = JSON.parse(heroScenarioDocument);
    const scenario = parseHeroScenario();
    expect(scenario.state.windows).toHaveLength(0);
    expect(scenario.state.wmRunning).toBe(false);
    expect(scenario.simulation).toEqual({ os: { kind: "macos" } });
    expect(source.steps.map((step: { command?: string }) => step.command).filter(Boolean)).toEqual([
      "service start",
      "window move right",
      "window move left",
      "window focus up",
      "workspace move-window T",
      "workspace move-window W",
    ]);
  });

  it("runs the verbatim hero document to the expected final workspace", async () => {
    const session = await createScenarioSession(JSON.parse(heroScenarioDocument));
    try {
      let state = await session.snapshot();
      for (let result = await session.step(); result !== null; result = await session.step()) {
        if (
          "command" in result.step &&
          result.step.command === "window move right" &&
          result.state.focusedWindow === "editor"
        ) {
          expect(result.state.windows.find(({ id }) => id === "editor")!.frame.x).toBeGreaterThan(
            state.windows.find(({ id }) => id === "editor")!.frame.x,
          );
        }
        if (
          "command" in result.step &&
          result.step.command === "window move left" &&
          result.state.focusedWindow === "editor"
        ) {
          expect(result.state.windows.find(({ id }) => id === "editor")!.frame.x).toBeLessThan(
            state.windows.find(({ id }) => id === "editor")!.frame.x,
          );
        }
        state = result.state;
      }
      expect(state.focusedWindow).toBe("settings");
      expect(state.focusedWorkspace).toBe("W");
      expect(
        Object.fromEntries(state.windows.map((window) => [window.id, window.workspace])),
      ).toEqual({
        terminal: "T",
        browser: "1",
        editor: "1",
        waitlist: "W",
        settings: "W",
      });
    } finally {
      await session.dispose();
    }
  });
});
