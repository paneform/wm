import { describe, expect, test } from "vitest";
import { Effect, Stream } from "effect";
import { createEngine } from "../src/engine.ts";
import type { Clock, ConfigSource } from "../src/platform.ts";
import {
  decodeObservationDocument,
  emptyObservationDocument,
  type ObservationDocument,
  type ObservationSnapshot,
  type ObservationStore,
} from "../src/observation-store.ts";
import type { WindowId } from "../src/schema.ts";
import { createFakePlatform, makeDisplay, makeWindow } from "./helpers/fake-platform.ts";

// Durable workspace arrangement (observation document v2): restarts restore
// focus and visibility instead of defaulting to workspace "1" (issue #6).

const CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (millis: number) => Effect.sleep(`${Math.min(millis, 2)} millis`),
};

const CONFIG_SOURCE: ConfigSource = {
  load: () => Effect.succeed({ defaults: {}, workspaces: [] }),
  changes: () => Stream.empty,
};

class MemoryObservationStore implements ObservationStore {
  revision = "seed";
  document: ObservationDocument = emptyObservationDocument();

  load(): Effect.Effect<ObservationSnapshot> {
    return Effect.succeed({ revision: this.revision, document: this.document });
  }

  changes(): Stream.Stream<ObservationSnapshot> {
    return Stream.empty;
  }

  save(
    _expectedRevision: string,
    document: ObservationDocument,
  ): Effect.Effect<ObservationSnapshot> {
    this.revision = `rev-${this.revision}`;
    this.document = document;
    return Effect.succeed({ revision: this.revision, document });
  }
}

const bootstrap = async (store: ObservationStore) => {
  const fake = createFakePlatform({
    clock: CLOCK,
    displays: [
      makeDisplay(),
      makeDisplay({
        id: "display:sim-left",
        frame: { x: -1512, y: 0, width: 1512, height: 982 },
        workArea: { x: -1512, y: 38, width: 1512, height: 944 },
        primary: false,
      }),
    ],
  });
  const engine = await Effect.runPromise(
    createEngine({ adapter: fake.adapter, configSource: CONFIG_SOURCE, clock: CLOCK, observationStore: store }),
  );
  await Effect.runPromise(engine.start());
  return { fake, engine };
};

const snapshotOf = async (engine: Awaited<ReturnType<typeof bootstrap>>["engine"]) =>
  Effect.runPromise(engine.state());

const seedWindowIn = async (
  h: Awaited<ReturnType<typeof bootstrap>>,
  id: WindowId,
  workspace: string,
): Promise<void> => {
  await Effect.runPromise(h.engine.execute({ type: "reconcile" }));
  await Effect.runPromise(
    h.engine.execute({ type: "moveWindowToWorkspace", windowId: id, workspace, follow: false }),
  );
};

describe("durable workspace arrangement across restarts (issue #6)", () => {
  test("restores focused workspace, visibility, and runtime workspaces", async () => {
    const store = new MemoryObservationStore();
    const first = await bootstrap(store);
    const w1 = first.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    await seedWindowIn(first, w1, "T");
    // Focus the runtime-created workspace: reveals it and selects it.
    await Effect.runPromise(first.engine.execute({ type: "focusWorkspace", name: "T" }));
    // Persistence coalesces to the next converged reconcile (never on the
    // command path); the fake emits no activation event here, so drive the
    // flushing cycle explicitly.
    await Effect.runPromise(first.engine.execute({ type: "reconcile" }));

    const saved = store.document.workspaceState;
    expect(saved).toBeDefined();
    expect(saved?.focusedWorkspace).toBe("T");
    const savedT = saved?.workspaces.find((entry) => entry.name === "T");
    expect(savedT?.visibleOnDisplay).toBe("display:sim-primary");
    await Effect.runPromise(first.engine.stop());

    // A fresh daemon (new adapter, same durable document) restores state.
    const second = await bootstrap(store);
    const snap = await snapshotOf(second.engine);
    expect(snap.focusedWorkspace).toBe("T");
    const restoredT = snap.workspaces.find((workspace) => workspace.name === "T");
    expect(restoredT?.visibleOnDisplay).toBe("display:sim-primary");
    // The old default ("1") stayed parked: no startup reveal churn.
    const restoredOne = snap.workspaces.find((workspace) => workspace.name === "1");
    expect(restoredOne?.visibleOnDisplay).toBeNull();
    // Settles without the focus flipping back to "1".
    await Effect.runPromise(second.engine.execute({ type: "reconcile" }));
    expect((await snapshotOf(second.engine)).focusedWorkspace).toBe("T");
  });

  test("v1 documents (no workspace section) keep the previous startup behavior", async () => {
    const store = new MemoryObservationStore();
    // A real v1 file round-trips through the decoder, which normalizes it.
    store.document = decodeObservationDocument({ schemaVersion: 1, profiles: [], pending: [] });
    const h = await bootstrap(store);
    const snap = await snapshotOf(h.engine);
    expect(snap.focusedWorkspace).toBe("1");
    expect(snap.workspaces.map((workspace) => workspace.name)).toEqual(["1"]);
  });

  test("visibility on a disconnected display degrades to parked and re-reveals", async () => {
    const store = new MemoryObservationStore();
    store.document = {
      schemaVersion: 2,
      profiles: [],
      pending: [],
      workspaceState: {
        focusedWorkspace: "T",
        workspaces: [
          { name: "T", visibleOnDisplay: "display:ghost", pinnedDisplayOverride: null },
        ],
      },
    };
    const h = await bootstrap(store);
    const snap = await snapshotOf(h.engine);
    // Focus survives; the unknown display parks the workspace and the
    // reveal-focused-workspace rule re-reveals it on a connected display.
    expect(snap.focusedWorkspace).toBe("T");
    const t = snap.workspaces.find((workspace) => workspace.name === "T");
    expect(t?.visibleOnDisplay).toBe("display:sim-primary");
  });
});
