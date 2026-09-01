import { describe, expect, it } from "vitest";
import * as layoutBrowser from "../src/index.ts";

describe("@paneform/layout-browser public entry", () => {
  it("imports without browser globals or automatic startup", () => {
    expect(Object.keys(layoutBrowser).sort()).toEqual([
      "createLayoutSimulator",
      "createWebPlatformSim",
      "mountLayoutRenderer",
    ]);
  });
});
