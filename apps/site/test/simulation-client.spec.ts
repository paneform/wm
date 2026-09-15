import { describe, expect, it, vi } from "vitest";

import { createSimulationClient } from "../src/lib/hero/simulation-client.js";
import type {
  HeroCommittedSnapshot,
  HeroSimulation,
} from "../src/lib/hero/create-hero-simulation.js";

describe("hero simulation client", () => {
  it("replays single-flight and ignores stale generation publications", async () => {
    const disposed: number[] = [];
    let created = 0;
    const client = createSimulationClient(async () => {
      const id = ++created;
      // SAFETY: The client lifecycle test only calls dispose on each simulation.
      return { dispose: async () => void disposed.push(id) } as HeroSimulation;
    });
    const first = await client.start();
    const [second, sameSecond] = await Promise.all([client.replay(), client.replay()]);
    const listener = vi.fn();
    client.subscribe(listener);
    // SAFETY: publish checks only validity and forwards this opaque value to the spy.
    const snapshot = { valid: true } as HeroCommittedSnapshot;

    client.publish(snapshot, first.generation);
    client.publish(snapshot, second.generation);

    expect(sameSecond).toBe(second);
    expect(created).toBe(2);
    expect(disposed).toEqual([1]);
    expect(listener).toHaveBeenCalledOnce();
    await client.dispose();
    expect(disposed).toEqual([1, 2]);
  });

  it("shares one in-flight disposal with every caller", async () => {
    let finishDisposal = () => {};
    const simulationDisposed = new Promise<void>((resolve) => (finishDisposal = resolve));
    const client = createSimulationClient(async () => {
      // SAFETY: The client lifecycle test only calls dispose on this simulation.
      return { dispose: () => simulationDisposed } as HeroSimulation;
    });
    await client.start();

    const first = client.dispose();
    const second = client.dispose();
    let secondFinished = false;
    void second.then(() => (secondFinished = true));
    await Promise.resolve();

    expect(secondFinished).toBe(false);
    finishDisposal();
    await Promise.all([first, second]);
    expect(secondFinished).toBe(true);
  });
});
