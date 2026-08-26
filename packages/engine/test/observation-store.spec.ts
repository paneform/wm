import { describe, expect, test } from "vitest";
import {
  decodeObservationDocument,
  learningFromObservationDocument,
  mergeLearningChanges,
  observationDocumentFromLearning,
  ObservationStoreError,
} from "../src/observation-store.ts";
import { emptyLearningStore, makeProfileKey, profileKeyString, recordCandidates } from "../src/learn.ts";

const key = makeProfileKey({
  application: "com.example.editor",
  role: "AXWindow",
  contextFingerprint: "topology-a",
});

describe("observation documents", () => {
  test("round-trips promoted profiles and pending evidence", () => {
    let learning = emptyLearningStore();
    learning = recordCandidates(learning, key, [
      { axis: "width", direction: "max", value: 723 },
      { axis: "width", direction: "max", value: 723 },
      { axis: "width", direction: "max", value: 723 },
      { axis: "height", direction: "min", value: 480 },
    ]).store;

    const restored = learningFromObservationDocument(observationDocumentFromLearning(learning));

    expect(restored.profiles.get(profileKeyString(key))?.constraints).toEqual({ maxWidth: 723 });
    expect(restored.pending.get(profileKeyString(key))?.get("height:min")).toEqual([480]);
  });

  test("rejects duplicate profiles and non-finite evidence", () => {
    const profile = {
      key,
      constraints: { maxWidth: 723 },
      sampleCount: 3,
      confidence: "learned",
      correctiveAttemptCount: 0,
      cooperative: false,
    };
    expect(() => decodeObservationDocument({
      schemaVersion: 1,
      profiles: [profile, profile],
      pending: [],
    })).toThrow(ObservationStoreError);
    expect(() => decodeObservationDocument({
      schemaVersion: 1,
      profiles: [],
      pending: [{ key, samples: { "width:max": [Number.NaN] } }],
    })).toThrow(ObservationStoreError);
  });

  test("rejects unsupported schema versions", () => {
    expect(() => decodeObservationDocument({ schemaVersion: 2, profiles: [], pending: [] }))
      .toThrow(/unsupported observation document schema/);
  });

  test("rejects contradictory resolved constraints", () => {
    expect(() => decodeObservationDocument({
      schemaVersion: 1,
      profiles: [{
        key,
        constraints: { minWidth: 800, maxWidth: 723 },
        sampleCount: 3,
        confidence: "learned",
        correctiveAttemptCount: 0,
        cooperative: false,
      }],
      pending: [],
    })).toThrow(/minWidth cannot exceed maxWidth/);
  });

  test("merges independent concurrent fields on the same profile", () => {
    const document = (profile: Record<string, unknown>) => ({
      schemaVersion: 1 as const,
      profiles: [{
        key,
        constraints: { maxWidth: 723 },
        sampleCount: 3,
        confidence: "learned",
        correctiveAttemptCount: 0,
        cooperative: false,
        ...profile,
      }],
      pending: [],
    });
    const base = learningFromObservationDocument(document({}));
    const local = learningFromObservationDocument(document({
      constraints: { maxWidth: 800 },
      sampleCount: 4,
    }));
    const remote = learningFromObservationDocument(document({
      constraints: { minWidth: 500, maxWidth: 723 },
      correctiveAttemptCount: 1,
      cooperative: true,
    }));

    const profile = mergeLearningChanges(base, local, remote).profiles.get(profileKeyString(key));

    expect(profile).toMatchObject({
      constraints: { minWidth: 500, maxWidth: 800 },
      sampleCount: 4,
      correctiveAttemptCount: 1,
      cooperative: true,
    });
  });

  test("merges compatible concurrent creation of the same profile", () => {
    const local = learningFromObservationDocument({
      schemaVersion: 1,
      profiles: [{
        key,
        constraints: { maxWidth: 723 },
        sampleCount: 3,
        confidence: "learned",
        correctiveAttemptCount: 0,
        cooperative: false,
      }],
      pending: [],
    });
    const remote = learningFromObservationDocument({
      schemaVersion: 1,
      profiles: [{
        key,
        constraints: { minWidth: 500 },
        sampleCount: 1,
        confidence: "tentative",
        correctiveAttemptCount: 1,
        cooperative: true,
      }],
      pending: [],
    });

    const profile = mergeLearningChanges(emptyLearningStore(), local, remote)
      .profiles.get(profileKeyString(key));

    expect(profile).toMatchObject({
      constraints: { minWidth: 500, maxWidth: 723 },
      sampleCount: 3,
      confidence: "learned",
      correctiveAttemptCount: 1,
      cooperative: true,
    });
  });
});
