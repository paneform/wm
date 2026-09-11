import { describe, expect, it } from "vitest";
import * as layoutBrowser from "../src/index.ts";

describe("@paneform/layout-browser public entry", () => {
  it("imports without browser globals or automatic startup", () => {
    expect(Object.keys(layoutBrowser)).toEqual(
      expect.arrayContaining([
        "createLayoutSimulator",
        "createWebPlatformSim",
        "mountLayoutRenderer",
        "createScenarioSession",
        "runScenario",
        "parseScenario",
        "scenarioJsonSchema",
      ]),
    );
  });
});
