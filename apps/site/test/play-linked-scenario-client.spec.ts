import {
  createScenarioSession,
  parseScenario,
  type LayoutScenario,
  type ScenarioStep,
  type SimulationState,
} from "@paneform/layout-browser";
import { describe, expect, it, vi } from "vitest";
import {
  createLinkedScenarioClient,
  type ScenarioClientFactory,
} from "../src/lib/play/linked-scenario-client.js";
import comparisonPresetDocument from "../src/lib/play/os-comparison.scenario.json";

const state: SimulationState = {
  topology: [{ id: "main", frame: { x: 0, y: 0, width: 1000, height: 700 }, workspace: "1" }],
  windows: [{ id: "A", frame: { x: 100, y: 100, width: 500, height: 400 }, workspace: "1" }],
  focusedWorkspace: "1",
  focusedWindow: "A",
  paused: false,
  wmRunning: false,
};

const scenario = (comparison = true): LayoutScenario => {
  const input: LayoutScenario = {
    config: { defaults: { gap: 8 } },
    presentation: comparison ? { comparison: "cooperative-macos" } : {},
    simulation: { os: { kind: "macos", horizontalFallback: 32 } },
    state,
    steps: [{ command: "state" }],
  };
  return input;
};

const createRealClient: ScenarioClientFactory = (input) => createScenarioSession(input);
const comparisonPreset = parseScenario(comparisonPresetDocument);

describe("linked scenario client", () => {
  it("creates one unchanged client without comparison", async () => {
    const inputs: LayoutScenario[] = [];
    const client = await createLinkedScenarioClient(scenario(false), undefined, async (input) => {
      inputs.push(input);
      return { snapshot: async () => state, apply: async () => state, dispose: async () => {} };
    });
    expect(inputs).toEqual([scenario(false)]);
    await expect(client.snapshot()).resolves.toEqual({ primary: state, comparison: null });
  });

  it("creates isolated CooperativeOS and MacOS inputs and passes the signal to both", async () => {
    const inputs: LayoutScenario[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const abort = new AbortController();
    const client = await createLinkedScenarioClient(
      scenario(),
      abort.signal,
      async (input, signal) => {
        inputs.push(input);
        signals.push(signal);
        return { snapshot: async () => state, apply: async () => state, dispose: async () => {} };
      },
    );
    expect(inputs[0]?.simulation?.os).toBe("none");
    expect(inputs[1]?.simulation?.os).toEqual({ kind: "macos", horizontalFallback: 32 });
    expect(inputs[0]?.state).toEqual(inputs[1]?.state);
    expect(inputs[0]?.config).toEqual(inputs[1]?.config);
    expect(inputs[0]?.steps).toEqual(inputs[1]?.steps);
    expect(inputs[0]).not.toBe(inputs[1]);
    expect(signals).toEqual([abort.signal, abort.signal]);
    await client.dispose();
  });

  it("uses arbitrary labels and per-side OS rules", async () => {
    const input: LayoutScenario = {
      ...scenario(false),
      presentation: {
        comparison: {
          primary: { label: "Restricted", subtext: "first", os: { kind: "macos" } },
          secondary: { label: "Also restricted", subtext: "second", os: { kind: "macos" } },
        },
      },
    };
    const seen: LayoutScenario[] = [];
    let call = 0;
    await expect(
      createLinkedScenarioClient(input, undefined, async (value) => {
        seen.push(value);
        if (call++ === 1) throw new Error("failed");
        return { snapshot: async () => state, apply: async () => state, dispose: async () => {} };
      }),
    ).rejects.toThrow("Also restricted: failed");
    expect(seen.map((value) => value.simulation?.os)).toEqual([
      { kind: "macos" },
      { kind: "macos" },
    ]);
  });

  it("uses clear side names for errors when custom labels are blank", async () => {
    const input: LayoutScenario = {
      ...scenario(false),
      presentation: {
        comparison: {
          primary: { label: " ", subtext: "", os: "none" },
          secondary: { label: "", subtext: "", os: { kind: "macos" } },
        },
      },
    };
    let call = 0;
    const client = await createLinkedScenarioClient(input, undefined, async () => {
      const side = call++;
      return {
        snapshot: async () => {
          throw new Error(side === 0 ? "left failed" : "right failed");
        },
        apply: async () => state,
        dispose: async () => {},
      };
    });
    await expect(client.snapshot()).rejects.toThrow(
      "Left simulation: left failed\nRight simulation: right failed",
    );
    await client.dispose();
  });

  it("cleans up a successful client after partial creation failure", async () => {
    const dispose = vi.fn(async () => {});
    let call = 0;
    const factory: ScenarioClientFactory = async () => {
      if (call++ === 1) throw new Error("startup failed");
      return { snapshot: async () => state, apply: async () => state, dispose };
    };
    await expect(createLinkedScenarioClient(scenario(), undefined, factory)).rejects.toThrow(
      "MacOS: startup failed",
    );
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("cleans up after a synchronous factory failure and labels a single session Scenario", async () => {
    const dispose = vi.fn(async () => {});
    let call = 0;
    const factory: ScenarioClientFactory = () => {
      if (call++ === 1) throw new Error("synchronous failure");
      return Promise.resolve({ snapshot: async () => state, apply: async () => state, dispose });
    };
    await expect(createLinkedScenarioClient(scenario(), undefined, factory)).rejects.toThrow(
      "MacOS: synchronous failure",
    );
    expect(dispose).toHaveBeenCalledOnce();

    await expect(
      createLinkedScenarioClient(scenario(false), undefined, () => {
        throw new Error("single failure");
      }),
    ).rejects.toThrow("Scenario: single failure");
  });

  it("labels both apply failures, poisons later applies, and keeps snapshots available", async () => {
    let call = 0;
    const factory: ScenarioClientFactory = async () => {
      const label = call++ === 0 ? "cooperative failure" : "mac failure";
      return {
        snapshot: async () => state,
        apply: async () => {
          throw new Error(label);
        },
        dispose: async () => {},
      };
    };
    const client = await createLinkedScenarioClient(scenario(), undefined, factory);
    await expect(client.apply({ command: "state" })).rejects.toThrow(
      "CooperativeOS: cooperative failure\nMacOS: mac failure",
    );
    await expect(client.apply({ command: "state" })).rejects.toThrow("recreate it");
    await expect(client.snapshot()).resolves.toEqual({ primary: state, comparison: state });
  });

  it("poisons both sessions when only MacOS rejects after CooperativeOS advances", async () => {
    const advanced = { ...state, paused: true };
    let call = 0;
    const primaryApply = vi.fn(async () => advanced);
    const macosApply = vi.fn(async () => {
      throw new Error("boundary failure");
    });
    const factory: ScenarioClientFactory = async () => {
      const primary = call++ % 2 === 0;
      return {
        snapshot: async () => (primary ? advanced : state),
        apply: primary ? primaryApply : macosApply,
        dispose: async () => {},
      };
    };
    const client = await createLinkedScenarioClient(scenario(), undefined, factory);
    const step: ScenarioStep = { command: "state" };
    await expect(client.apply(step)).rejects.toThrow("MacOS: boundary failure");
    expect(primaryApply).toHaveBeenCalledOnce();
    expect(macosApply).toHaveBeenCalledOnce();
    expect(primaryApply).toHaveBeenCalledWith(step);
    expect(macosApply).toHaveBeenCalledWith(step);
    await expect(client.snapshot()).resolves.toEqual({ primary: advanced, comparison: state });
    await expect(client.apply(step)).rejects.toThrow("recreate it");
    expect(primaryApply).toHaveBeenCalledOnce();
    expect(macosApply).toHaveBeenCalledOnce();

    const replacement = await createLinkedScenarioClient(scenario(), undefined, factory);
    await expect(replacement.apply(step)).rejects.toThrow("MacOS: boundary failure");
    expect(primaryApply).toHaveBeenCalledTimes(2);
    expect(macosApply).toHaveBeenCalledTimes(2);
    await Promise.all([client.dispose(), replacement.dispose()]);
  });

  it("serializes frames and sends isolated copies of the same step", async () => {
    const received: ScenarioStep[] = [];
    const releases: (() => void)[] = [];
    const factory: ScenarioClientFactory = async () => ({
      snapshot: async () => state,
      apply: (step) => {
        received.push(step);
        return new Promise((resolve) => releases.push(() => resolve(state)));
      },
      dispose: async () => {},
    });
    const client = await createLinkedScenarioClient(scenario(), undefined, factory);
    const first = client.apply({ command: "state", caption: "first" });
    const second = client.apply({ command: "state", caption: "second" });
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received[0]).toEqual(received[1]);
    expect(received[0]).not.toBe(received[1]);
    releases.splice(0).forEach((release) => release());
    await first;
    await vi.waitFor(() => expect(received).toHaveLength(4));
    releases.splice(0).forEach((release) => release());
    await second;
  });

  it("queues snapshots behind applies to return a consistent pair", async () => {
    const order: string[] = [];
    const releases: (() => void)[] = [];
    const factory: ScenarioClientFactory = async () => ({
      apply: () =>
        new Promise((resolve) => {
          order.push("apply");
          releases.push(() => resolve(state));
        }),
      snapshot: async () => {
        order.push("snapshot");
        return state;
      },
      dispose: async () => {},
    });
    const client = await createLinkedScenarioClient(scenario(), undefined, factory);
    const applying = client.apply({ command: "state" });
    const snapshot = client.snapshot();
    await vi.waitFor(() => expect(order).toEqual(["apply", "apply"]));
    releases.splice(0).forEach((release) => release());
    await applying;
    await snapshot;
    expect(order).toEqual(["apply", "apply", "snapshot", "snapshot"]);
  });

  it("disposes promptly and idempotently while rejecting queued and future work", async () => {
    const dispose = vi.fn(async () => {});
    const factory: ScenarioClientFactory = async () => ({
      apply: () => new Promise(() => {}),
      snapshot: async () => state,
      dispose,
    });
    const client = await createLinkedScenarioClient(scenario(), undefined, factory);
    void client.apply({ command: "state" }).catch(() => undefined);
    const queued = client.snapshot();
    await client.dispose();
    await client.dispose();
    expect(dispose).toHaveBeenCalledTimes(2);
    await expect(queued).rejects.toThrow("disposed");
    await expect(client.apply({ command: "state" })).rejects.toThrow("disposed");
    await expect(client.snapshot()).rejects.toThrow("disposed");
  });

  it("keeps IDs aligned while macOS constrains stopped-window moves and replay is repeatable", async () => {
    const input = scenario();
    const client = await createLinkedScenarioClient(input, undefined, createRealClient);
    try {
      const moved = await client.apply({
        event: {
          kind: "window_changed",
          window: { id: "A", frame: { x: -900, y: -800, width: 500, height: 400 } },
        },
      });
      expect(moved.primary.windows.map(({ id }) => id)).toEqual(
        moved.comparison?.windows.map(({ id }) => id),
      );
      expect(moved.primary.windows[0]?.frame).not.toEqual(moved.comparison?.windows[0]?.frame);
      await client.apply({ event: { kind: "window_removed", windowId: "A" } });
      const final = await client.apply({ command: "service start" });
      expect(final.primary.windows).toEqual([]);
      expect(final.comparison?.windows).toEqual([]);
    } finally {
      await client.dispose();
    }

    const replay = async () => {
      const session = await createLinkedScenarioClient(input, undefined, createRealClient);
      try {
        return await session.apply({ event: { kind: "focus_changed", windowId: "A" } });
      } finally {
        await session.dispose();
      }
    };
    expect(await replay()).toEqual(await replay());
  });

  it("replays the same recorded drag offscreen on CooperativeOS and clamped on macOS", async () => {
    const client = await createLinkedScenarioClient(scenario(), undefined, createRealClient);
    try {
      const moved = await client.apply({
        event: {
          kind: "window_dragged",
          windowId: "A",
          displayId: "main",
          startFrame: state.windows[0]!.frame,
          from: { x: 350, y: 120 },
          to: { x: -650, y: -680 },
          duration: 600,
        },
      });
      expect(moved.primary.windows[0]?.frame).toEqual({
        x: -900,
        y: -700,
        width: 500,
        height: 400,
      });
      expect(moved.comparison?.windows[0]?.frame).not.toEqual(moved.primary.windows[0]?.frame);
    } finally {
      await client.dispose();
    }
  });

  it("replays the full comparison preset repeatably and accepts a MacOS-source frame", async () => {
    const replay = async () => {
      const client = await createLinkedScenarioClient(
        comparisonPreset,
        undefined,
        createRealClient,
      );
      const frames = [];
      try {
        for (const step of comparisonPreset.steps ?? []) frames.push(await client.apply(step));
        return frames;
      } finally {
        await client.dispose();
      }
    };
    const first = await replay();
    expect(first).toHaveLength(7);
    expect(first[1]?.primary.windows[0]?.frame).not.toEqual(
      first[1]?.comparison?.windows[0]?.frame,
    );
    expect(await replay()).toEqual(first);

    const client = await createLinkedScenarioClient(comparisonPreset, undefined, createRealClient);
    try {
      const added = comparisonPreset.steps?.[0];
      const moved = comparisonPreset.steps?.[1];
      if (added === undefined || moved === undefined) throw new Error("Preset steps are missing");
      await client.apply(added);
      const divergent = await client.apply(moved);
      const macosFrame = divergent.comparison?.windows[0]?.frame;
      if (macosFrame === undefined) throw new Error("MacOS frame is missing");
      const synchronized = await client.apply({
        event: {
          kind: "window_changed",
          window: { id: "window:browser", frame: macosFrame },
        },
      });
      expect(synchronized.primary.windows[0]?.frame).toEqual(macosFrame);
      expect(synchronized.comparison?.windows[0]?.frame).toEqual(macosFrame);
    } finally {
      await client.dispose();
    }
  });

  it("uses a default macOS descriptor when the source has none", async () => {
    const { simulation: _, ...withoutSimulation } = scenario();
    const input: LayoutScenario = withoutSimulation;
    const seen: LayoutScenario[] = [];
    const client = await createLinkedScenarioClient(input, undefined, async (value) => {
      seen.push(value);
      return { snapshot: async () => state, apply: async () => state, dispose: async () => {} };
    });
    expect(seen[1]?.simulation?.os).toEqual({ kind: "macos" });
    await client.dispose();
  });
});
