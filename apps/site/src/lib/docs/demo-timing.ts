const commandLeadMs = 300;
const transitionMs = 500;

/** Docs playback uses one cadence for timers, CSS transitions and indicator travel. */
export const DEMO_TIMING = {
  prepareHoldMs: 1000,
  commandLeadMs,
  transitionMs,
  playbackMs: commandLeadMs + transitionMs,
  resultHoldMs: 1000,
  sequenceHoldMs: 1200,
  flashFadeMs: transitionMs / 2,
  scrollSettleMs: 150,
} as const;
