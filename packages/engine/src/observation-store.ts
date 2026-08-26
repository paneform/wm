import type { LearningStore } from "./learn.ts";
import { emptyLearningStore, profileKeyString } from "./learn.ts";
import type { Constraints } from "./schema.ts";
import type { Confidence, Profile, ProfileKey } from "./world.ts";
import type { Effect, Stream } from "effect";

export const OBSERVATION_SCHEMA_VERSION = 1 as const;

const PENDING_IDS = ["width:min", "width:max", "height:min", "height:max"] as const;
type PendingId = (typeof PENDING_IDS)[number];

export interface StoredPendingEvidence {
  readonly key: ProfileKey;
  readonly samples: Partial<Record<PendingId, readonly number[]>>;
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

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertKnownKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void => {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown !== undefined) {
    throw new ObservationStoreError("invalid", `${name} contains unknown field ${unknown}`);
  }
};

const finitePositive = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1_000_000) {
    throw new ObservationStoreError("invalid", `${name} must be a finite positive number`);
  }
  return value;
};

const nonNegativeInteger = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ObservationStoreError("invalid", `${name} must be a non-negative integer`);
  }
  return value;
};

const nonEmptyString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) {
    throw new ObservationStoreError("invalid", `${name} must be a non-empty string without NUL characters`);
  }
  return value;
};

const decodeKey = (value: unknown): ProfileKey => {
  if (!isObject(value)) throw new ObservationStoreError("invalid", "profile key must be an object");
  assertKnownKeys(value, ["application", "role", "subrole", "contextFingerprint"], "profile key");
  const key: ProfileKey = {
    application: nonEmptyString(value["application"], "profile application"),
    role: nonEmptyString(value["role"], "profile role"),
    contextFingerprint: nonEmptyString(value["contextFingerprint"], "profile context fingerprint"),
  };
  if (value["subrole"] !== undefined) {
    key.subrole = nonEmptyString(value["subrole"], "profile subrole");
  }
  return key;
};

const decodeConstraints = (value: unknown): Constraints => {
  if (!isObject(value)) throw new ObservationStoreError("invalid", "constraints must be an object");
  assertKnownKeys(value, ["minWidth", "maxWidth", "minHeight", "maxHeight"], "constraints");
  const constraints: Constraints = {
    ...(value["minWidth"] === undefined
      ? {}
      : { minWidth: finitePositive(value["minWidth"], "minWidth") }),
    ...(value["maxWidth"] === undefined
      ? {}
      : { maxWidth: finitePositive(value["maxWidth"], "maxWidth") }),
    ...(value["minHeight"] === undefined
      ? {}
      : { minHeight: finitePositive(value["minHeight"], "minHeight") }),
    ...(value["maxHeight"] === undefined
      ? {}
      : { maxHeight: finitePositive(value["maxHeight"], "maxHeight") }),
  };
  if (
    constraints.minWidth !== undefined && constraints.maxWidth !== undefined &&
    constraints.minWidth > constraints.maxWidth
  ) {
    throw new ObservationStoreError("invalid", "minWidth cannot exceed maxWidth");
  }
  if (
    constraints.minHeight !== undefined && constraints.maxHeight !== undefined &&
    constraints.minHeight > constraints.maxHeight
  ) {
    throw new ObservationStoreError("invalid", "minHeight cannot exceed maxHeight");
  }
  return constraints;
};

const decodeProfile = (value: unknown): Profile => {
  if (!isObject(value)) throw new ObservationStoreError("invalid", "profile must be an object");
  assertKnownKeys(
    value,
    ["key", "constraints", "sampleCount", "confidence", "correctiveAttemptCount", "cooperative"],
    "profile",
  );
  const confidence = value["confidence"];
  if (confidence !== "tentative" && confidence !== "learned" && confidence !== "strong") {
    throw new ObservationStoreError("invalid", "profile confidence is invalid");
  }
  if (typeof value["cooperative"] !== "boolean") {
    throw new ObservationStoreError("invalid", "profile cooperative must be boolean");
  }
  return {
    key: decodeKey(value["key"]),
    constraints: decodeConstraints(value["constraints"]),
    sampleCount: nonNegativeInteger(value["sampleCount"], "profile sampleCount"),
    confidence: confidence as Confidence,
    correctiveAttemptCount: nonNegativeInteger(
      value["correctiveAttemptCount"],
      "profile correctiveAttemptCount",
    ),
    cooperative: value["cooperative"],
  };
};

const decodeSamples = (value: unknown): Partial<Record<PendingId, readonly number[]>> => {
  if (!isObject(value)) throw new ObservationStoreError("invalid", "pending samples must be an object");
  assertKnownKeys(value, PENDING_IDS, "pending samples");
  const samples: Partial<Record<PendingId, readonly number[]>> = {};
  for (const id of PENDING_IDS) {
    const candidate = value[id];
    if (candidate === undefined) continue;
    if (!Array.isArray(candidate) || candidate.length > 16) {
      throw new ObservationStoreError("invalid", `${id} samples must be a bounded array`);
    }
    samples[id] = candidate.map((sample) => finitePositive(sample, `${id} sample`));
  }
  return samples;
};

/** Validate untrusted durable data before it enters the engine. */
export function decodeObservationDocument(value: unknown): ObservationDocument {
  if (!isObject(value) || value["schemaVersion"] !== OBSERVATION_SCHEMA_VERSION) {
    throw new ObservationStoreError("invalid", "unsupported observation document schema");
  }
  assertKnownKeys(value, ["schemaVersion", "profiles", "pending"], "observation document");
  if (!Array.isArray(value["profiles"]) || value["profiles"].length > 10_000) {
    throw new ObservationStoreError("invalid", "profiles must be a bounded array");
  }
  if (!Array.isArray(value["pending"]) || value["pending"].length > 10_000) {
    throw new ObservationStoreError("invalid", "pending evidence must be a bounded array");
  }

  const profileKeys = new Set<string>();
  const profiles = value["profiles"].map((entry) => {
    const profile = decodeProfile(entry);
    const key = profileKeyString(profile.key);
    if (profileKeys.has(key)) throw new ObservationStoreError("invalid", `duplicate profile ${key}`);
    profileKeys.add(key);
    return profile;
  });

  const pendingKeys = new Set<string>();
  const pending = value["pending"].map((entry) => {
    if (!isObject(entry)) throw new ObservationStoreError("invalid", "pending evidence must be an object");
    assertKnownKeys(entry, ["key", "samples"], "pending evidence");
    const key = decodeKey(entry["key"]);
    const keyString = profileKeyString(key);
    if (pendingKeys.has(keyString)) {
      throw new ObservationStoreError("invalid", `duplicate pending evidence ${keyString}`);
    }
    pendingKeys.add(keyString);
    return { key, samples: decodeSamples(entry["samples"]) };
  });

  return { schemaVersion: OBSERVATION_SCHEMA_VERSION, profiles, pending };
}

const keyFromString = (value: string): ProfileKey => {
  const parts = value.split("\u0000");
  if (parts.length !== 4) throw new ObservationStoreError("invalid", "invalid internal profile key");
  const [application, role, subrole, contextFingerprint] = parts as [string, string, string, string];
  return decodeKey({
    application,
    role,
    ...(subrole.length > 0 ? { subrole } : {}),
    contextFingerprint,
  });
};

export function observationDocumentFromLearning(store: LearningStore): ObservationDocument {
  const profiles = [...store.profiles.values()].sort((a, b) =>
    profileKeyString(a.key).localeCompare(profileKeyString(b.key))
  );
  const pending = [...store.pending.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([keyString, buckets]) => ({
      key: store.profiles.get(keyString)?.key ?? keyFromString(keyString),
      samples: Object.fromEntries(
        [...buckets.entries()]
          .filter(([id]) => (PENDING_IDS as readonly string[]).includes(id))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, values]) => [id, [...values]]),
      ) as Partial<Record<PendingId, readonly number[]>>,
    }));
  return decodeObservationDocument({
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    profiles,
    pending,
  });
}

export function learningFromObservationDocument(value: unknown): LearningStore {
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

const sameValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const mergeConstraints = (
  base: Constraints,
  local: Constraints,
  remote: Constraints,
): Constraints => {
  const merged = { ...remote } as Record<string, number | undefined>;
  for (const field of ["minWidth", "maxWidth", "minHeight", "maxHeight"] as const) {
    if (sameValue(base[field], local[field])) continue;
    if (local[field] === undefined) delete merged[field];
    else merged[field] = local[field];
  }
  const result = merged as Constraints;
  if (
    (result.minWidth !== undefined && result.maxWidth !== undefined && result.minWidth > result.maxWidth) ||
    (result.minHeight !== undefined && result.maxHeight !== undefined && result.minHeight > result.maxHeight)
  ) {
    return { ...local };
  }
  return result;
};

const mergeProfile = (base: Profile, local: Profile, remote: Profile): Profile => ({
  ...remote,
  constraints: mergeConstraints(base.constraints, local.constraints, remote.constraints),
  sampleCount: sameValue(base.sampleCount, local.sampleCount) ? remote.sampleCount : local.sampleCount,
  confidence: sameValue(base.confidence, local.confidence) ? remote.confidence : local.confidence,
  correctiveAttemptCount: sameValue(base.correctiveAttemptCount, local.correctiveAttemptCount)
    ? remote.correctiveAttemptCount
    : local.correctiveAttemptCount,
  cooperative: sameValue(base.cooperative, local.cooperative) ? remote.cooperative : local.cooperative,
});

const confidenceRank: Record<Confidence, number> = { tentative: 0, learned: 1, strong: 2 };

const mergeAddedProfile = (local: Profile, remote: Profile): Profile => ({
  ...remote,
  constraints: mergeConstraints({}, local.constraints, remote.constraints),
  sampleCount: Math.max(local.sampleCount, remote.sampleCount),
  confidence: confidenceRank[local.confidence] >= confidenceRank[remote.confidence]
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
