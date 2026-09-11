import { Effect } from "effect";
import type { Clock, Random } from "./platform.js";

// Test-support surface — deterministic Clock and Random for headless tests
// and the renderer simulation. The fake PlatformAdapter itself lives in
// test/helpers (TEST agent); everything it needs to be deterministic is here.

export interface TestClock extends Clock {
  /** Advance virtual time, firing due sleeps in scheduling order. */
  advance(millis: number): void;
  advanceTo(atMs: number): void;
  pendingCount(): number;
  nextWake(): number | null;
}

export const createTestClock = (startMs = 0): TestClock => {
  let now = startMs;
  interface Wake {
    at: number;
    order: number;
    resume: (effect: Effect.Effect<void>) => void;
    cancelled: boolean;
  }
  const wakes: Wake[] = [];
  let order = 0;

  return {
    now: () => now,
    sleep(millis) {
      return Effect.async<void>((resume) => {
        order += 1;
        const wake: Wake = { at: now + millis, order, resume, cancelled: false };
        wakes.push(wake);
        wakes.sort((a, b) => a.at - b.at || a.order - b.order);
        return Effect.sync(() => {
          wake.cancelled = true;
          const index = wakes.indexOf(wake);
          if (index >= 0) wakes.splice(index, 1);
        });
      });
    },
    advance(millis) {
      this.advanceTo(now + millis);
    },
    advanceTo(target) {
      now = target;
      while (wakes.length > 0 && wakes[0]!.at <= now) {
        const wake = wakes.shift()!;
        if (!wake.cancelled) wake.resume(Effect.void);
      }
    },
    pendingCount: () => wakes.length,
    nextWake: () => wakes[0]?.at ?? null,
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
export interface Collector<T> {
  push(value: T): void;
  values(): readonly T[];
}

export const createCollector = <T>(): Collector<T> => {
  const seen: T[] = [];
  return {
    push: (value) => seen.push(value),
    values: () => [...seen],
  };
};
