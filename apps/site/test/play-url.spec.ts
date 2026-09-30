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
      state: {
        ...emptyPlaygroundScenario.state,
        windows: [
          {
            id: "window:editor",
            frame: { x: 100, y: 80, width: 640, height: 480 },
          },
        ],
        focusedWindow: "window:editor",
      },
      simulation: {
        os: { kind: "macos", horizontalFallback: 48, bottomVisible: 64 },
      },
      presentation: {
        ...emptyPlaygroundScenario.presentation,
        devices: { "display:main": "display" },
        showDock: false,
        showWindowSettings: false,
        comparison: {
          primary: { label: "", subtext: "", os: "none" },
          secondary: {
            label: "Authored macOS",
            subtext: "Custom constraints",
            os: { kind: "macos", horizontalFallback: 24 },
          },
        },
      },
      steps: [
        {
          event: {
            kind: "window_dragged",
            windowId: "window:editor",
            displayId: "display:main",
            startFrame: { x: 100, y: 80, width: 640, height: 480 },
            from: { x: 420, y: 100 },
            to: { x: -800, y: -300 },
            duration: 600,
          },
          caption: "Raw attempted gesture",
        },
        {
          playback: "start",
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
    expect(decoded?.presentation?.showWindowSettings).toBe(false);
    expect(decoded?.presentation?.comparison).toEqual(scenario.presentation?.comparison);
    expect(decoded?.steps?.[0]).toEqual(scenario.steps?.[0]);
    expect(decoded?.steps?.[1]?.playback).toBe("start");
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
