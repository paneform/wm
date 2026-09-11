import { createTestClock } from "@paneform/layout/testing";
import { Effect, Fiber, Scheduler } from "effect";

/** Own all engine scheduling so deadline sleeps cannot race runnable work. */
export function createScenarioRuntime() {
  const clock = createTestClock();
  const scheduler = new Scheduler.ControlledScheduler();

  const drain = async (): Promise<void> => {
    const deadline = clock.now() + 120_000;
    for (let turn = 0; turn < 100_000; turn += 1) {
      scheduler.step();
      await Promise.resolve();
      if (scheduler.tasks.buckets.length > 0) continue;
      const next = clock.nextWake();
      if (next === null) return;
      if (next > deadline) throw new Error("Scenario exceeded its virtual-time budget");
      clock.advanceTo(next);
    }
    throw new Error("Scenario did not settle within its scheduling budget");
  };

  const run = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
    const fiber = Effect.runFork(effect, { scheduler });
    try {
      await drain();
      const exit = fiber.unsafePoll();
      if (exit === null) throw new Error("Scenario stalled while waiting for engine work");
      return Effect.runSync(exit);
    } catch (error) {
      const interruption = Effect.runFork(Fiber.interrupt(fiber), { scheduler });
      try {
        await drain();
        if (interruption.unsafePoll() === null) throw new Error("Scenario cleanup stalled");
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Scenario execution and cleanup failed");
      }
      throw error;
    }
  };

  return { clock, run, drain };
}
