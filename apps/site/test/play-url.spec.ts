import { gzipSync } from "node:zlib";
import { parseScenario } from "@paneform/layout-browser";
import { describe, expect, it } from "vitest";
import { emptyPlaygroundScenario } from "../src/lib/play/playground-defaults.js";
import {
  decodeScenarioFragment,
  encodeScenarioFragment,
  MAX_SCENARIO_BYTES,
} from "../src/lib/play/scenario-url.js";

describe("scenario URL sharing", () => {
  it("round-trips a complete scenario, presentation, and Unicode captions", async () => {
    const scenario = parseScenario({
      ...emptyPlaygroundScenario,
      simulation: {
        os: { kind: "macos", horizontalFallback: 48, bottomVisible: 64 },
      },
      presentation: {
        ...emptyPlaygroundScenario.presentation,
        devices: { "display:main": "display" },
        showDock: false,
      },
      steps: [
        {
          command: "service start",
          caption: "Focus: caf\u00e9, \u7a97, \ud83e\ude9f",
          expect: { wmRunning: true },
        },
      ],
    });
    const fragment = await encodeScenarioFragment(scenario);
    expect(fragment).toMatch(/^#scenario=gz\.[A-Za-z0-9_-]+$/);
    const decoded = await decodeScenarioFragment(fragment);
    expect(decoded).toEqual(scenario);
    expect(decoded?.simulation).toEqual({
      os: { kind: "macos", horizontalFallback: 48, bottomVisible: 64 },
    });
  });

  it("loads standard gzip payloads and leaves unrelated fragments alone", async () => {
    const bytes = gzipSync(JSON.stringify(emptyPlaygroundScenario));
    expect(await decodeScenarioFragment(`#scenario=gz.${bytes.toString("base64url")}`)).toEqual(
      parseScenario(emptyPlaygroundScenario),
    );
    expect(await decodeScenarioFragment("")).toBeNull();
    expect(await decodeScenarioFragment("#advanced")).toBeNull();
  });

  it("rejects malformed encoding and oversized decompression before JSON parsing", async () => {
    for (const hash of [
      "#scenario=raw.test",
      "#scenario=gz.%",
      "#scenario=gz.A",
      "#scenario=gz.dGVzdA",
    ]) {
      await expect(decodeScenarioFragment(hash)).rejects.toThrow();
    }
    const bomb = gzipSync(" ".repeat(MAX_SCENARIO_BYTES + 1)).toString("base64url");
    await expect(decodeScenarioFragment(`#scenario=gz.${bomb}`)).rejects.toThrow("size limit");
    await expect(decodeScenarioFragment(`#scenario=gz.${"A".repeat(40_000)}`)).rejects.toThrow(
      "too large",
    );
  });

  it("keeps raw playground defaults genuinely empty and stopped", () => {
    const scenario = parseScenario(emptyPlaygroundScenario);
    expect(scenario.state.windows).toEqual([]);
    expect(scenario.state.wmRunning).toBe(false);
    expect(scenario.simulation).toEqual({ os: { kind: "macos" } });
    expect(scenario.steps).toBeUndefined();
    expect(scenario.presentation).toMatchObject({
      device: "laptop",
      showKeyboard: true,
      showDock: true,
      showTopBar: true,
    });
  });
});
