import { describe, expect, it } from "vitest";

import { createActionArbiter } from "../src/lib/hero/action-arbiter.js";

describe("hero action arbiter", () => {
  it("lets an in-flight action settle and keeps only the newest pending user intent", async () => {
    const arbiter = createActionArbiter();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const order: string[] = [];
    const generation = arbiter.beginAutoplay();
    const script = arbiter.submitScript(generation, async () => {
      await gate;
      order.push("script");
      return "script";
    });
    const first = arbiter.submitUser(async () => {
      order.push("first");
      return "first";
    });
    const second = arbiter.submitUser(async () => {
      order.push("second");
      return "second";
    });

    release();

    await expect(script).resolves.toEqual({ status: "completed", value: "script" });
    await expect(first).resolves.toEqual({ status: "superseded" });
    await expect(second).resolves.toEqual({ status: "completed", value: "second" });
    expect(order).toEqual(["script", "second"]);
  });

  it("rejects stale autoplay generations", async () => {
    const arbiter = createActionArbiter();
    const generation = arbiter.beginAutoplay();
    arbiter.invalidateAutoplay();
    await expect(arbiter.submitScript(generation, async () => 1)).resolves.toEqual({
      status: "invalidated",
    });
  });
});
