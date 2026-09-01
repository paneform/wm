// Numeric constants from docs/rewrite/domain-schema.md §Numeric constants.
// Every threshold used anywhere in the engine is collected here.

export const DEFAULT_TOLERANCE = 1;
export const MIN_TOLERANCE = 0;
export const MAX_TOLERANCE = 20;

export const DEFAULT_ATTEMPTS = 3;
export const MIN_ATTEMPTS = 1;
export const MAX_ATTEMPTS = 5;

export const RETRY_LADDER = [
  "positionSize",
  "sizeOnly",
  "sizePositionSize",
  "convergedSizePositionSize",
] as const;
export type WriteStrategy = (typeof RETRY_LADDER)[number];

/** Engine settle polling: at most this many reads, delay between non-matching reads. */
export const SETTLE_MAX_READS = 11;
export const SETTLE_POLL_DELAY_MS = 17;

/** Position-only verification: Δpos ≤1, Δsize ≤1. */
export const POSITION_VERIFY_TOLERANCE = 1;

export const PROBE_DELTA = 1;
export const PROBE_MATCH_THRESHOLD = 0.25;
export const RESTORE_MATCH_THRESHOLD = 0.25;

/** Work-area edge distance used to reject display-clamped size evidence. */
export const WORK_AREA_FLUSH_GUARD_PT = 2;

export const PROMOTION_SAMPLES = 3;
export const PROMOTION_CONSISTENCY_PT = 1;
export const STRONG_CONFIDENCE_SAMPLES = 8;
export const LEARNED_CONFIDENCE_SAMPLES = 3;

export const VIABILITY_MARGIN_PT = 1;

/** Tiling containment acceptance: within content ±1 pt OR center inside content. */
export const CONTAINMENT_TOLERANCE_PT = 1;
/** Replan bound per layout pass: memberCount + REPLAN_BONUS. */
export const REPLAN_BONUS = 1;

export const PARKING_ACCEPTANCE_PT = 1;
export const PARKING_TYPICAL_VISIBILITY = { horizontal: 1, vertical: 52 } as const;

export const BSP_DEFAULT_GAP = 8;
export const RESIZE_INCREMENT_DEFAULT = 0.05;

export const POLICY_CHAIN = ["greedy", "overlap", "stack", "overflow"] as const;
export type LayoutPolicy = (typeof POLICY_CHAIN)[number] | "reject";
export const DEFAULT_POLICY_CHAIN: readonly LayoutPolicy[] = [...POLICY_CHAIN];

export const TRANSACTION_PENDING_LIMIT = 256;
export const TRANSACTION_HISTORY_LIMIT = 512;
export const TRANSACTION_TIMEOUT_MS = 15_000;
export const SUSPICIOUS_REPEAT_THRESHOLD = 3;
export const BATCH_COMMAND_CAP = 64;

export const EVENT_REPLAY_BUFFER = 512;

export const WIRE_PROTOCOL_VERSION = 1;

/**
 * A workspace whose tree has been emptied still needs a BspNode; it is a leaf
 * with this sentinel id. All membership queries filter it out.
 */
export const EMPTY_TREE_LEAF = "";
