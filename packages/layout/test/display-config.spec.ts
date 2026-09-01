import { Effect, Stream } from "effect";
import { describe, expect, test } from "vitest";
import { createEngine } from "../src/engine.ts";
import type { Config, Margins, Matcher } from "../src/config.ts";
import type { Clock, ConfigSource } from "../src/platform.ts";
import { createFakePlatform, makeDisplay, makeWindow } from "./helpers/fake-platform.ts";

const CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (millis) => Effect.sleep(`${Math.min(millis, 2)} millis`),
};

const BUILTIN = makeDisplay({
  id: "display:builtin",
  primary: true,
  frame: { x: 0, y: 0, width: 1200, height: 900 },
  workArea: { x: 0, y: 0, width: 1200, height: 900 },
});
const DELL = makeDisplay({
  id: "display:d5c2e106-7238-4cb0-a9bf-16a4b2b6de7f",
  primary: false,
  frame: { x: 1200, y: 0, width: 1600, height: 900 },
  workArea: { x: 1200, y: 0, width: 1600, height: 900 },
});

interface WorkspaceFixture {
  name: string;
  preferredDisplay?: string;
  margins?: Margins;
  assign?: readonly Matcher[];
}

const displayConfig = (workspaceMargins?: { top: number }): Config => {
  const workspace: WorkspaceFixture = {
    name: "dell",
    preferredDisplay: DELL.id,
    assign: [{ bundleId: "com.example.dell" }],
  };
  if (workspaceMargins !== undefined) workspace.margins = workspaceMargins;
  return {
    defaults: { margins: { top: 4, right: 0, bottom: 0, left: 0 }, gap: 8 },
    displays: [
      { display: BUILTIN.id, margins: { top: 0 }, gap: 0 },
      { display: DELL.id, margins: { top: 32 }, gap: 0 },
    ],
    workspaces: [workspace],
  };
};

const sourceFor = (load: () => Config): ConfigSource => ({
  load: () => Effect.succeed(load()),
  changes: () => Stream.empty,
});

describe("display-scoped layout settings", () => {
  test("assignment preflight uses the hidden workspace destination display", async () => {
    const fake = createFakePlatform({ clock: CLOCK, displays: [BUILTIN, DELL] });
    const id = fake.addWindow(makeWindow({ bundleId: "com.example.dell", x: 100, y: 100 }));
    const engine = await Effect.runPromise(
      createEngine({
        adapter: fake.adapter,
        configSource: sourceFor(() => displayConfig()),
        clock: CLOCK,
      }),
    );

    await Effect.runPromise(engine.start());

    expect(fake.frameOf(id)).toMatchObject({ x: DELL.workArea.x, y: 32 });
    expect(
      (await Effect.runPromise(engine.state())).workspaces.find((ws) => ws.name === "dell")
        ?.members,
    ).toContain(id);
    await Effect.runPromise(engine.stop());
  });

  test("workspace margin overrides the matched Dell margin", async () => {
    const fake = createFakePlatform({ clock: CLOCK, displays: [BUILTIN, DELL] });
    const id = fake.addWindow(makeWindow({ bundleId: "com.example.dell" }));
    const engine = await Effect.runPromise(
      createEngine({
        adapter: fake.adapter,
        configSource: sourceFor(() => displayConfig({ top: 12 })),
        clock: CLOCK,
      }),
    );

    await Effect.runPromise(engine.start());

    expect(fake.frameOf(id)?.y).toBe(12);
    await Effect.runPromise(engine.stop());
  });

  test("compound move plans against the destination and reconnects by stable id", async () => {
    const fake = createFakePlatform({ clock: CLOCK, displays: [BUILTIN, DELL] });
    const id = fake.addWindow(makeWindow({ bundleId: "com.example.main", x: 100, y: 100 }));
    const engine = await Effect.runPromise(
      createEngine({
        adapter: fake.adapter,
        configSource: sourceFor(() => displayConfig()),
        clock: CLOCK,
      }),
    );
    await Effect.runPromise(engine.start());

    await Effect.runPromise(
      engine.execute({ type: "moveWorkspaceToDisplay", workspace: "1", displayId: DELL.id }),
    );
    expect(fake.frameOf(id)).toMatchObject({ x: DELL.workArea.x, y: 32 });

    fake.disconnectDisplay(DELL.id);
    await Effect.runPromise(engine.reconcile());
    fake.connectDisplay(DELL);
    await Effect.runPromise(engine.reconcile());
    await Effect.runPromise(
      engine.execute({ type: "moveWorkspaceToDisplay", workspace: "1", displayId: DELL.id }),
    );
    expect(fake.frameOf(id)).toMatchObject({ x: DELL.workArea.x, y: 32 });
    await Effect.runPromise(engine.stop());
  });

  test("delta hotload retiles a visible workspace with its display override", async () => {
    let candidate: Config = {};
    const fake = createFakePlatform({ clock: CLOCK, displays: [DELL] });
    const id = fake.addWindow(makeWindow({ bundleId: "com.example.main", x: 100, y: 100 }));
    const engine = await Effect.runPromise(
      createEngine({
        adapter: fake.adapter,
        configSource: sourceFor(() => candidate),
        clock: CLOCK,
      }),
    );
    await Effect.runPromise(engine.start());
    expect(fake.frameOf(id)?.y).toBe(0);

    candidate = { displays: [{ display: DELL.id, margins: { top: 32 }, gap: 0 }] };
    await Effect.runPromise(engine.execute({ type: "reloadConfig", mode: "delta" }));

    expect(fake.frameOf(id)?.y).toBe(32);
    await Effect.runPromise(engine.stop());
  });
});
