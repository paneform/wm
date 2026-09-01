import type { LearningStore } from "./learn.js";
import { emptyLearningStore, profileKeyString } from "./learn.js";
import type { Constraints } from "./schema.js";
import type { Confidence, Profile, ProfileKey } from "./world.js";
import type { Effect, Stream } from "effect";
import { Schema } from "effect";

export const OBSERVATION_SCHEMA_VERSION = 1 as const;

const PENDING_IDS = ["width:min", "width:max", "height:min", "height:max"] as const;
type PendingId = (typeof PENDING_IDS)[number];

export interface StoredPendingEvidence {
  readonly key: ProfileKey;
  readonly samples: Partial<Record<PendingId, readonly number[]>>;
}

interface MutableConstraints {
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
}

export interface ObservationDocument {
  readonly schemaVersion: typeof OBSERVATION_SCHEMA_VERSION;
  readonly profiles: readonly Profile[];
  readonly pending: readonly StoredPendingEvidence[];
}

export interface ObservationSnapshot {
  /** Opaque store revision. File stores may use a content digest. */
  readonly revision: string;
  readonly document: ObservationDocument;
}

export type ObservationStoreErrorCode = "busy" | "conflict" | "durability" | "invalid" | "io";

export class ObservationStoreError extends Error {
  readonly code: ObservationStoreErrorCode;
  readonly committed?: ObservationSnapshot;

  constructor(code: ObservationStoreErrorCode, message: string, committed?: ObservationSnapshot) {
    super(message);
    this.name = "ObservationStoreError";
    this.code = code;
    if (committed !== undefined) this.committed = committed;
  }
}

export interface ObservationStore {
  load(): Effect.Effect<ObservationSnapshot, ObservationStoreError>;
  changes(afterRevision: string): Stream.Stream<ObservationSnapshot, ObservationStoreError>;
  save(
    expectedRevision: string,
    document: ObservationDocument,
  ): Effect.Effect<ObservationSnapshot, ObservationStoreError>;
}

export const emptyObservationDocument = (): ObservationDocument => ({
  schemaVersion: OBSERVATION_SCHEMA_VERSION,
  profiles: [],
  pending: [],
});

export type ObservationJson =
  | null
  | boolean
  | number
  | string
  | readonly ObservationJson[]
  | { readonly [key: string]: ObservationJson };

const NonEmptyString = Schema.String.pipe(
  Schema.filter((value) => value.length > 0 && !value.includes("\u0000")),
);
const FinitePositive = Schema.Number.pipe(
  Schema.filter((value) => Number.isFinite(value) && value > 0 && value <= 1_000_000),
);
const NonNegativeInteger = Schema.Number.pipe(
  Schema.filter((value) => Number.isSafeInteger(value) && value >= 0),
);
const ProfileKeySchema = Schema.Struct({
  application: NonEmptyString,
  role: NonEmptyString,
  subrole: Schema.optional(NonEmptyString),
  contextFingerprint: NonEmptyString,
});
const ConstraintsSchema = Schema.Struct({
  minWidth: Schema.optional(FinitePositive),
  maxWidth: Schema.optional(FinitePositive),
  minHeight: Schema.optional(FinitePositive),
  maxHeight: Schema.optional(FinitePositive),
});
const ProfileSchema = Schema.Struct({
  key: ProfileKeySchema,
  constraints: ConstraintsSchema,
  sampleCount: NonNegativeInteger,
  confidence: Schema.Literal("tentative", "learned", "strong"),
  correctiveAttemptCount: NonNegativeInteger,
  cooperative: Schema.Boolean,
});
const SamplesSchema = Schema.Struct({
  "width:min": Schema.optional(Schema.Array(FinitePositive).pipe(Schema.maxItems(16))),
  "width:max": Schema.optional(Schema.Array(FinitePositive).pipe(Schema.maxItems(16))),
  "height:min": Schema.optional(Schema.Array(FinitePositive).pipe(Schema.maxItems(16))),
  "height:max": Schema.optional(Schema.Array(FinitePositive).pipe(Schema.maxItems(16))),
});
const ObservationDocumentSchema = Schema.Struct({
  schemaVersion: Schema.Literal(OBSERVATION_SCHEMA_VERSION),
  profiles: Schema.Array(ProfileSchema).pipe(Schema.maxItems(10_000)),
  pending: Schema.Array(Schema.Struct({ key: ProfileKeySchema, samples: SamplesSchema })).pipe(
    Schema.maxItems(10_000),
  ),
});

const validateConstraints = (constraints: Constraints): Constraints => {
  if (
    constraints.minWidth !== undefined &&
    constraints.maxWidth !== undefined &&
    constraints.minWidth > constraints.maxWidth
  ) {
    throw new ObservationStoreError("invalid", "minWidth cannot exceed maxWidth");
  }
  if (
    constraints.minHeight !== undefined &&
    constraints.maxHeight !== undefined &&
    constraints.minHeight > constraints.maxHeight
  ) {
    throw new ObservationStoreError("invalid", "minHeight cannot exceed maxHeight");
  }
  return constraints;
};

/** Validate untrusted durable data before it enters the engine. */
export function decodeObservationDocument<Input>(value: Input): ObservationDocument {
  let decoded: Schema.Schema.Type<typeof ObservationDocumentSchema>;
  try {
    decoded = Schema.decodeUnknownSync(ObservationDocumentSchema, {
      onExcessProperty: "error",
    })(value);
  } catch (error) {
    throw new ObservationStoreError(
      "invalid",
      `unsupported observation document schema: ${String(error)}`,
    );
  }

  const profileKeys = new Set<string>();
  const profiles = decoded.profiles.map((decodedProfile): Profile => {
    const key: ProfileKey = {
      application: decodedProfile.key.application,
      role: decodedProfile.key.role,
      contextFingerprint: decodedProfile.key.contextFingerprint,
    };
    if (decodedProfile.key.subrole !== undefined) key.subrole = decodedProfile.key.subrole;
    const profile: Profile = {
      ...decodedProfile,
      key,
      constraints: validateConstraints(decodedProfile.constraints),
    };
    const keyString = profileKeyString(profile.key);
    if (profileKeys.has(keyString))
      throw new ObservationStoreError("invalid", `duplicate profile ${keyString}`);
    profileKeys.add(keyString);
    return profile;
  });

  const pendingKeys = new Set<string>();
  const pending = decoded.pending.map((entry): StoredPendingEvidence => {
    const key: ProfileKey = {
      application: entry.key.application,
      role: entry.key.role,
      contextFingerprint: entry.key.contextFingerprint,
    };
    if (entry.key.subrole !== undefined) key.subrole = entry.key.subrole;
    const keyString = profileKeyString(key);
    if (pendingKeys.has(keyString)) {
      throw new ObservationStoreError("invalid", `duplicate pending evidence ${keyString}`);
    }
    pendingKeys.add(keyString);
    const samples: Partial<Record<PendingId, readonly number[]>> = {};
    for (const id of PENDING_IDS) {
      const values = entry.samples[id];
      if (values !== undefined) samples[id] = values;
    }
    return { key, samples };
  });

  return { schemaVersion: OBSERVATION_SCHEMA_VERSION, profiles, pending };
}

const keyFromString = (value: string): ProfileKey => {
  const parts = value.split("\u0000");
  if (parts.length !== 4)
    throw new ObservationStoreError("invalid", "invalid internal profile key");
  const application = parts[0];
  const role = parts[1];
  const subrole = parts[2];
  const contextFingerprint = parts[3];
  if (
    application === undefined ||
    role === undefined ||
    subrole === undefined ||
    contextFingerprint === undefined
  ) {
    throw new ObservationStoreError("invalid", "invalid internal profile key");
  }
  const key: ProfileKey = {
    application,
    role,
    contextFingerprint,
  };
  if (subrole.length > 0) key.subrole = subrole;
  try {
    Schema.decodeUnknownSync(ProfileKeySchema, { onExcessProperty: "error" })(key);
  } catch (error) {
    throw new ObservationStoreError("invalid", `invalid internal profile key: ${String(error)}`);
  }
  return key;
};

export function observationDocumentFromLearning(store: LearningStore): ObservationDocument {
  const profiles = [...store.profiles.values()].sort((a, b) =>
    profileKeyString(a.key).localeCompare(profileKeyString(b.key)),
  );
  const pending = [...store.pending.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([keyString, buckets]) => {
      const samples: Partial<Record<PendingId, readonly number[]>> = {};
      for (const id of PENDING_IDS) {
        const values = buckets.get(id);
        if (values !== undefined) samples[id] = [...values];
      }
      return {
        key: store.profiles.get(keyString)?.key ?? keyFromString(keyString),
        samples,
      };
    });
  return decodeObservationDocument({
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    profiles,
    pending,
  });
}

export function learningFromObservationDocument<Input>(value: Input): LearningStore {
  const document = decodeObservationDocument(value);
  const store = emptyLearningStore();
  const profiles = new Map<string, Profile>();
  for (const profile of document.profiles) profiles.set(profileKeyString(profile.key), profile);
  const pending = new Map<string, ReadonlyMap<string, readonly number[]>>();
  for (const entry of document.pending) {
    pending.set(
      profileKeyString(entry.key),
      new Map(Object.entries(entry.samples).map(([id, samples]) => [id, [...samples]])),
    );
  }
  return { ...store, profiles, pending };
}

const sameValue = <Value>(left: Value, right: Value): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const mergeConstraints = (
  base: Constraints,
  local: Constraints,
  remote: Constraints,
): Constraints => {
  const merged: MutableConstraints = {};
  for (const field of ["minWidth", "maxWidth", "minHeight", "maxHeight"] as const) {
    if (remote[field] !== undefined) merged[field] = remote[field];
  }
  for (const field of ["minWidth", "maxWidth", "minHeight", "maxHeight"] as const) {
    if (sameValue(base[field], local[field])) continue;
    if (local[field] === undefined) delete merged[field];
    else merged[field] = local[field];
  }
  if (
    (merged.minWidth !== undefined &&
      merged.maxWidth !== undefined &&
      merged.minWidth > merged.maxWidth) ||
    (merged.minHeight !== undefined &&
      merged.maxHeight !== undefined &&
      merged.minHeight > merged.maxHeight)
  ) {
    return { ...local };
  }
  return merged;
};

const mergeProfile = (base: Profile, local: Profile, remote: Profile): Profile => ({
  ...remote,
  constraints: mergeConstraints(base.constraints, local.constraints, remote.constraints),
  sampleCount: sameValue(base.sampleCount, local.sampleCount)
    ? remote.sampleCount
    : local.sampleCount,
  confidence: sameValue(base.confidence, local.confidence) ? remote.confidence : local.confidence,
  correctiveAttemptCount: sameValue(base.correctiveAttemptCount, local.correctiveAttemptCount)
    ? remote.correctiveAttemptCount
    : local.correctiveAttemptCount,
  cooperative: sameValue(base.cooperative, local.cooperative)
    ? remote.cooperative
    : local.cooperative,
});

const confidenceRank: Record<Confidence, number> = { tentative: 0, learned: 1, strong: 2 };

const mergeAddedProfile = (local: Profile, remote: Profile): Profile => ({
  ...remote,
  constraints: mergeConstraints({}, local.constraints, remote.constraints),
  sampleCount: Math.max(local.sampleCount, remote.sampleCount),
  confidence:
    confidenceRank[local.confidence] >= confidenceRank[remote.confidence]
      ? local.confidence
      : remote.confidence,
  correctiveAttemptCount: Math.max(local.correctiveAttemptCount, remote.correctiveAttemptCount),
  cooperative: local.cooperative || remote.cooperative,
});

/** Apply local changes made since `base` on top of a newer remote catalog. */
export function mergeLearningChanges(
  base: LearningStore,
  local: LearningStore,
  remote: LearningStore,
): LearningStore {
  const profiles = new Map(remote.profiles);
  for (const key of new Set([...base.profiles.keys(), ...local.profiles.keys()])) {
    const before = base.profiles.get(key);
    const after = local.profiles.get(key);
    if (sameValue(before, after)) continue;
    if (after === undefined) profiles.delete(key);
    else {
      const remoteProfile = profiles.get(key);
      profiles.set(
        key,
        remoteProfile === undefined
          ? after
          : before === undefined
            ? mergeAddedProfile(after, remoteProfile)
            : mergeProfile(before, after, remoteProfile),
      );
    }
  }

  const pending = new Map(remote.pending);
  for (const key of new Set([...base.pending.keys(), ...local.pending.keys()])) {
    const before = base.pending.get(key);
    const after = local.pending.get(key);
    const beforeRecord = before === undefined ? undefined : Object.fromEntries(before);
    const afterRecord = after === undefined ? undefined : Object.fromEntries(after);
    if (sameValue(beforeRecord, afterRecord)) continue;
    if (after === undefined) pending.delete(key);
    else if (before === undefined || pending.get(key) === undefined) pending.set(key, after);
    else {
      const merged = new Map(pending.get(key));
      for (const id of new Set([...before.keys(), ...after.keys()])) {
        if (sameValue(before.get(id), after.get(id))) continue;
        const samples = after.get(id);
        if (samples === undefined) merged.delete(id);
        else merged.set(id, samples);
      }
      pending.set(key, merged);
    }
  }
  return { profiles, pending };
}
