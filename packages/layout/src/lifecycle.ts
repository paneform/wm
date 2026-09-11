import { Effect } from "effect";

export const LIFECYCLE_PHASES = [
  "observe",
  "membershipFocus",
  "plan",
  "apply",
  "refreshVerify",
  "publish",
] as const;

export type LifecyclePhase = (typeof LIFECYCLE_PHASES)[number];

export interface LifecycleHooks<Batch, Observation, Membership, Plan, Applied, Verified, Result> {
  readonly observe: (batch: Batch) => Effect.Effect<Observation>;
  readonly membershipFocus: (observation: Observation, batch: Batch) => Membership;
  readonly plan: (membership: Membership) => Plan;
  readonly apply: (plan: Plan, membership: Membership) => Effect.Effect<Applied>;
  readonly refreshVerify: (applied: Applied) => Effect.Effect<Verified>;
  readonly publish: (verified: Verified) => Effect.Effect<Result>;
}

/** Internal typed lifecycle seam. Scheduling and extension policy stay engine-owned. */
export const runLifecycle = <Batch, Observation, Membership, Plan, Applied, Verified, Result>(
  hooks: LifecycleHooks<Batch, Observation, Membership, Plan, Applied, Verified, Result>,
  batch: Batch,
): Effect.Effect<Result> =>
  Effect.gen(function* () {
    const observation = yield* hooks.observe(batch);
    const membership = hooks.membershipFocus(observation, batch);
    const plan = hooks.plan(membership);
    const applied = yield* hooks.apply(plan, membership);
    const verified = yield* hooks.refreshVerify(applied);
    return yield* hooks.publish(verified);
  });
