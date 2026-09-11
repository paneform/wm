import { Effect, Fiber } from "effect";
import { describe, expect, test } from "vitest";
import { createTestClock } from "../src/testing.ts";

describe("TestClock", () => {
  test("reports the next wake while preserving advance behavior", async () => {
    const clock = createTestClock(100);
    const fiber = Effect.runFork(clock.sleep(25));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(clock.pendingCount()).toBe(1);
    expect(clock.nextWake()).toBe(125);
    clock.advance(25);
    await Effect.runPromise(Fiber.join(fiber));
    expect(clock.nextWake()).toBeNull();
  });

  test("removes interrupted sleeps", async () => {
    const clock = createTestClock();
    const fiber = Effect.runFork(clock.sleep(50));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(clock.nextWake()).toBe(50);

    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(clock.pendingCount()).toBe(0);
    expect(clock.nextWake()).toBeNull();
  });
});
