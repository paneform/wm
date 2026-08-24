import { Effect } from "effect";
import type { Clock, Random } from "./platform.ts";

// Test-support surface — deterministic Clock and Random for headless tests
// and the renderer simulation. The fake PlatformAdapter itself lives in
// test/helpers (TEST agent); everything it needs to be deterministic is here.

interface TestClock extends Clock {
  /** Advance virtual time, firing due sleeps in scheduling order. */
  advance(millis: number): void;
  advanceTo(atMs: number): void;
  pendingCount(): number;
}

export const createTestClock = (startMs = 0): TestClock => {
  let now = startMs;
  interface Wake {
    at: number;
    order: number;
    resume: (effect: Effect.Effect<void>) => void;
  }
  const wakes: Wake[] = [];
  let order = 0;

  return {
    now: () => now,
    sleep(millis) {
      return Effect.async<void>((resume) => {
        order += 1;
        wakes.push({ at: now + millis, order, resume });
        wakes.sort((a, b) => a.at - b.at || a.order - b.order);
      });
    },
    advance(millis) {
      this.advanceTo(now + millis);
    },
    advanceTo(target) {
      now = target;
      while (wakes.length > 0 && wakes[0]!.at <= now) {
        const wake = wakes.shift()!;
        wake.resume(Effect.void);
      }
    },
    pendingCount: () => wakes.length,
  };
};

interface SeededRandom extends Random {
  state(): number;
}

/** Mulberry32 — tiny deterministic PRNG sufficient for probe scenarios. */
export const createSeededRandom = (seed: number): SeededRandom => {
  let state = seed >>> 0;
  return {
    nextInt(maxExclusive: number): number {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      const unit = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      return Math.floor(unit * Math.max(1, maxExclusive));
    },
    state: () => state,
  };
};

/** Run an Effect program to completion as a Promise (tests/host boundary). */
export const runToPromise = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect);

/** Collect the first n events pushed into an array by a subscriber. */
export const createCollector = <T>(): {
  push(value: T): void;
  values(): readonly T[];
} => {
  const seen: T[] = [];
  return {
    push: (value) => seen.push(value),
    values: () => [...seen],
  };
};
