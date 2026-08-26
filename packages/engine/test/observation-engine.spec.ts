import { describe, expect, test } from "vitest";
import { Effect, Stream } from "effect";
import { createEngine } from "../src/engine.ts";
import { contextFingerprint } from "../src/learn.ts";
import {
  emptyObservationDocument,
  ObservationStoreError,
  type ObservationDocument,
  type ObservationSnapshot,
  type ObservationStore,
} from "../src/observation-store.ts";
import type { Clock, ConfigSource } from "../src/platform.ts";
import type { Profile } from "../src/world.ts";
import { createFakePlatform, makeDisplay, makeWindow } from "./helpers/fake-platform.ts";

const CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (millis) => Effect.sleep(`${millis >= 15_000 ? 100 : Math.min(millis, 2)} millis`),
};

const CONFIG: ConfigSource = {
  load: () => Effect.succeed({
    defaults: {
      gap: 0,
      margins: { top: 0, right: 0, bottom: 0, left: 0 },
    },
  }),
  changes: () => Stream.empty,
};

const profileDocument = (fingerprint: string, maxWidth: number): ObservationDocument => ({
  schemaVersion: 1,
  profiles: [{
    key: {
      application: "com.apple.systempreferences",
      role: "AXWindow",
      contextFingerprint: fingerprint,
    },
    constraints: { maxWidth },
    sampleCount: 3,
    confidence: "learned",
    correctiveAttemptCount: 0,
    cooperative: false,
  } satisfies Profile],
  pending: [],
});

const createTestStore = (
  initial: ObservationDocument,
  options: { failSaves?: boolean; conflictOnceWith?: ObservationDocument } = {},
) => {
  let snapshot: ObservationSnapshot = { revision: "r1", document: initial };
  let conflicted = false;
  let listener: ((next: ObservationSnapshot) => void) | undefined;
  const saved: ObservationDocument[] = [];
  const store: ObservationStore = {
    load: () => Effect.succeed(snapshot),
    changes: () => Stream.asyncPush<ObservationSnapshot>((emit) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          listener = (next) => emit.single(next);
        }),
        () => Effect.sync(() => {
          listener = undefined;
        }),
      )),
    save: (expectedRevision, document) => {
      if (options.failSaves === true) {
        return Effect.fail(new ObservationStoreError("io", "test persistence failure"));
      }
      if (!conflicted && options.conflictOnceWith !== undefined) {
        conflicted = true;
        snapshot = { revision: "external-conflict", document: options.conflictOnceWith };
        return Effect.fail(new ObservationStoreError("conflict", "test revision conflict"));
      }
      if (expectedRevision !== snapshot.revision) {
        return Effect.die(new Error("unexpected test revision conflict"));
      }
      return Effect.sync(() => {
        saved.push(document);
        snapshot = { revision: `r${saved.length + 1}`, document };
        return snapshot;
      });
    },
  };
  return {
    store,
    saved,
    publish: (document: ObservationDocument) => {
      snapshot = { revision: `external-${Date.now()}`, document };
      listener?.(snapshot);
    },
  };
};

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

describe("engine observation-store integration", () => {
  test("workspace focus persists a leading-edge maximum clamp", async () => {
    const display = makeDisplay({
      frame: { x: 0, y: 0, width: 1512, height: 982 },
      workArea: { x: 0, y: 32, width: 1512, height: 950 },
    });
    const fake = createFakePlatform({ clock: CLOCK, displays: [display] });
    const settings = fake.addWindow(makeWindow({
      id: "window:settings-learning",
      bundleId: "com.apple.systempreferences",
      x: 100,
      y: 100,
      width: 723,
      height: 950,
      personality: { kind: "minMaxClamp", constraints: { maxWidth: 723 } },
    }));
    fake.addWindow(makeWindow({
      id: "window:terminal-learning",
      bundleId: "com.example.terminal",
      x: 900,
      y: 100,
      width: 600,
      height: 950,
    }));
    const configSource: ConfigSource = {
      load: () => Effect.succeed({
        defaults: {
          gap: 0,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
        },
        workspaces: [
          { name: "C", assign: [{ bundleId: "com.apple.systempreferences" }] },
          { name: "T", assign: [{ bundleId: "com.example.terminal" }] },
        ],
      }),
      changes: () => Stream.empty,
    };
    const observations = createTestStore(emptyObservationDocument());
    const engine = await Effect.runPromise(createEngine({
      adapter: fake.adapter,
      configSource,
      observationStore: observations.store,
      clock: CLOCK,
      initiallyPaused: true,
    }));
    await Effect.runPromise(engine.start());
    await Effect.runPromise(engine.reconcile());
    expect(fake.writes()).toEqual([]);

    await Effect.runPromise(engine.execute({ type: "resume" }));
    await Effect.runPromise(engine.execute({ type: "focusWorkspace", name: "C" }));

    expect(fake.frameOf(settings)).toMatchObject({ x: 0, width: 723 });
    expect((await Effect.runPromise(engine.state())).focusedWorkspace).toBe("C");
    expect(observations.saved.at(-1)?.profiles.find((profile) =>
      profile.key.application === "com.apple.systempreferences")?.constraints.maxWidth).toBe(723);
    await Effect.runPromise(engine.stop());
  });

  test("hydrates learned bounds before the first useful layout", async () => {
    const display = makeDisplay();
    const fake = createFakePlatform({ clock: CLOCK, displays: [display] });
    const settings = fake.addWindow(makeWindow({
      id: "window:settings",
      bundleId: "com.apple.systempreferences",
      width: 900,
    }));
    const chat = fake.addWindow(makeWindow({ id: "window:chat", bundleId: "com.openai.codex", width: 900 }));
    const observations = createTestStore(profileDocument(contextFingerprint({ displays: [display] }), 723));
    const engine = await Effect.runPromise(createEngine({
      adapter: fake.adapter,
      configSource: CONFIG,
      observationStore: observations.store,
      clock: CLOCK,
    }));

    await Effect.runPromise(engine.start());
    await Effect.runPromise(engine.reconcile());

    expect(fake.frameOf(settings)).toMatchObject({ x: 0, width: 723 });
    expect(fake.frameOf(chat)).toMatchObject({ x: 723, width: 789 });
    await Effect.runPromise(engine.stop());
  });

  test("applies an external durable correction while running", async () => {
    const display = makeDisplay();
    const fake = createFakePlatform({ clock: CLOCK, displays: [display] });
    const settings = fake.addWindow(makeWindow({
      id: "window:settings-external",
      bundleId: "com.apple.systempreferences",
      width: 900,
    }));
    const chat = fake.addWindow(makeWindow({
      id: "window:chat-external",
      bundleId: "com.openai.codex",
      width: 900,
    }));
    const observations = createTestStore(emptyObservationDocument());
    const engine = await Effect.runPromise(createEngine({
      adapter: fake.adapter,
      configSource: CONFIG,
      observationStore: observations.store,
      clock: CLOCK,
    }));
    await Effect.runPromise(engine.start());
    await Effect.runPromise(engine.reconcile());

    observations.publish(profileDocument(contextFingerprint({ displays: [display] }), 723));
    await settle();

    expect(fake.frameOf(settings)).toMatchObject({ x: 0, width: 723 });
    expect(fake.frameOf(chat)).toMatchObject({ x: 723, width: 789 });
    await Effect.runPromise(engine.stop());
  });

  test("persists an exact frame that corrects a learned maximum", async () => {
    const display = makeDisplay();
    const fake = createFakePlatform({ clock: CLOCK, displays: [display] });
    const settings = fake.addWindow(makeWindow({
      id: "window:settings-correction",
      bundleId: "com.apple.systempreferences",
      width: 900,
    }));
    const observations = createTestStore(profileDocument(contextFingerprint({ displays: [display] }), 723));
    const engine = await Effect.runPromise(createEngine({
      adapter: fake.adapter,
      configSource: CONFIG,
      observationStore: observations.store,
      clock: CLOCK,
    }));
    await Effect.runPromise(engine.start());

    await Effect.runPromise(engine.execute({
      type: "setWindowFrame",
      windowId: settings,
      frame: { x: 0, y: 38, width: 800, height: 944 },
    }));

    expect(observations.saved.at(-1)?.profiles[0]?.constraints.maxWidth).toBe(800);
    await Effect.runPromise(engine.stop());
  });

  test("keeps the durable catalog authoritative when a passive save fails", async () => {
    const display = makeDisplay();
    const fake = createFakePlatform({ clock: CLOCK, displays: [display] });
    const settings = fake.addWindow(makeWindow({
      id: "window:settings-save-failure",
      bundleId: "com.apple.systempreferences",
      width: 900,
    }));
    const observations = createTestStore(
      profileDocument(contextFingerprint({ displays: [display] }), 723),
      { failSaves: true },
    );
    const engine = await Effect.runPromise(createEngine({
      adapter: fake.adapter,
      configSource: CONFIG,
      observationStore: observations.store,
      clock: CLOCK,
    }));
    await Effect.runPromise(engine.start());

    await Effect.runPromise(engine.execute({
      type: "setWindowFrame",
      windowId: settings,
      frame: { x: 0, y: 38, width: 800, height: 944 },
    }));

    expect((await Effect.runPromise(engine.state())).health).toBe("degraded");
    expect(observations.saved).toHaveLength(0);
    await Effect.runPromise(engine.stop());
  });

  test("reloads and merges local evidence after a revision conflict", async () => {
    const display = makeDisplay();
    const fingerprint = contextFingerprint({ displays: [display] });
    const initial = profileDocument(fingerprint, 723);
    const external: ObservationDocument = {
      ...initial,
      profiles: [
        ...initial.profiles,
        {
          key: {
            application: "com.openai.codex",
            role: "AXWindow",
            contextFingerprint: fingerprint,
          },
          constraints: { minWidth: 500 },
          sampleCount: 3,
          confidence: "learned",
          correctiveAttemptCount: 0,
          cooperative: false,
        },
      ],
    };
    const fake = createFakePlatform({ clock: CLOCK, displays: [display] });
    const settings = fake.addWindow(makeWindow({
      id: "window:settings-conflict",
      bundleId: "com.apple.systempreferences",
      width: 900,
    }));
    const observations = createTestStore(initial, { conflictOnceWith: external });
    const engine = await Effect.runPromise(createEngine({
      adapter: fake.adapter,
      configSource: CONFIG,
      observationStore: observations.store,
      clock: CLOCK,
    }));
    await Effect.runPromise(engine.start());

    await Effect.runPromise(engine.execute({
      type: "setWindowFrame",
      windowId: settings,
      frame: { x: 0, y: 38, width: 800, height: 944 },
    }));

    const committed = observations.saved.at(-1)!;
    expect(committed.profiles.find((profile) =>
      profile.key.application === "com.apple.systempreferences")?.constraints.maxWidth).toBe(800);
    expect(committed.profiles.find((profile) =>
      profile.key.application === "com.openai.codex")?.constraints.minWidth).toBe(500);
    await Effect.runPromise(engine.stop());
  });
});
