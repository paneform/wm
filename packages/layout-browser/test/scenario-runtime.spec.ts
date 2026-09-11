import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createScenarioRuntime } from "../src/scenario-runtime.js";

describe("scenario scheduling", () => {
  it("finishes asynchronous interruption cleanup before rejecting a stall", async () => {
    const runtime = createScenarioRuntime();
    let cleaned = false;
    const cleanup = Effect.zipRight(
      runtime.clock.sleep(5),
      Effect.sync(() => {
        cleaned = true;
      }),
    );
    await expect(runtime.run(Effect.never.pipe(Effect.ensuring(cleanup)))).rejects.toThrow(
      "stalled",
    );
    expect(cleaned).toBe(true);
    expect(runtime.clock.pendingCount()).toBe(0);
    expect(await runtime.run(Effect.succeed("ready"))).toBe("ready");
  });

  it("cancels losing deadlines without advancing through them", async () => {
    const runtime = createScenarioRuntime();
    await runtime.run(Effect.race(runtime.clock.sleep(5), runtime.clock.sleep(15_000)));
    expect(runtime.clock.now()).toBe(5);
    expect(runtime.clock.pendingCount()).toBe(0);
  });
});
