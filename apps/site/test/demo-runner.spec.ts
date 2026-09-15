import { describe, expect, it, vi } from "vitest";

import { createActionArbiter } from "../src/lib/hero/action-arbiter.js";
import { createDemoRunner } from "../src/lib/hero/demo-runner.js";
import type { HeroActionResult, HeroSimulation } from "../src/lib/hero/create-hero-simulation.js";

describe("hero demo runner", () => {
  it.each([true, false])("executes the reduced-motion path with includeSettings=%s", async (includeSettings) => {
    const calls: string[] = [];
    // SAFETY: This partial snapshot is never inspected by the runner under test.
    const success = { ok: true, snapshot: { valid: true } } as HeroActionResult;
    // SAFETY: The runner path only calls the action methods supplied here.
    const simulation = {
      activateApp: async (app) => (calls.push(`app:${app}`), success),
      moveFocusedWindowToWorkspace: async (workspace) => (
        calls.push(`window:${workspace}`),
        success
      ),
      connectStudioDisplay: async () => (calls.push("connect"), success),
      moveFocusedWorkspaceToNextDisplay: async () => (calls.push("display"), success),
      focusWorkspace: async (workspace) => (calls.push(`focus:${workspace}`), success),
      moveDirection: async (direction) => (calls.push(`move:${direction}`), success),
      focusDirection: async (direction) => (calls.push(`select:${direction}`), success),
    } as HeroSimulation;
    const presentation = {
      run: vi.fn(),
      commandExecuting: vi.fn((cue) => {
        if (cue.action.type === "launch-wm") calls.push(`execute:${cue.id}`);
      }),
      settleFinal: vi.fn(),
    };
    const runner = createDemoRunner({
      includeSettings,
      simulation,
      arbiter: createActionArbiter(),
      presentation,
      scheduler: { now: () => 0, wait: vi.fn() },
    });

    await expect(runner.run({ reducedMotion: true })).resolves.toEqual({
      status: "completed",
      activeTime: includeSettings ? 22_000 : 20_800,
    });
    expect(presentation.run).not.toHaveBeenCalled();
    expect(presentation.settleFinal).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      "app:Terminal",
      "app:Browser",
      "app:Text Editor",
      "execute:launch-paneform",
      "app:Paneform",
      "move:right",
      "move:left",
      "select:up",
      "window:T",
      "app:Waitlist",
      "window:W",
      ...(includeSettings ? ["app:Settings"] : []),
    ]);
    expect(calls.indexOf("execute:launch-paneform")).toBe(calls.indexOf("app:Paneform") - 1);
  });
});
