import { Effect } from "effect";
import type { Clock } from "@wm/engine";

/** Real-time Clock backed by the Node event loop. */
export const clockNode: Clock = {
  now: () => Date.now(),
  sleep: (millis: number) => Effect.sleep(`${millis} millis`),
};
