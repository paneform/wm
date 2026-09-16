import { createEngine, type Command, type Engine } from "@paneform/layout";
import { Effect, Stream } from "effect";
import { parseScenarioCommand } from "./scenario-commands.js";
import {
  parseScenario,
  type LayoutScenario,
  type ScenarioEvent,
  type ScenarioExpectation,
  type ScenarioStep,
  type SimulationDisplay,
  type SimulationState,
  type SimulationWindow,
} from "./scenario.js";
import { createScenarioRuntime } from "./scenario-runtime.js";
import { createMacOsRules } from "./sim/macos-rules.js";
import { unconstrainedOsRules } from "./sim/os-rules.js";
import {
  createWebPlatformSim,
  type AddWindowSpec,
  type DisplaySpec,
  type WebPlatformSim,
} from "./sim/web-platform.js";

export interface ScenarioStepResult {
  readonly index: number;
  readonly step: ScenarioStep;
  readonly state: SimulationState;
}

export interface ScenarioSession {
  readonly engine: Engine | null;
  readonly sim: WebPlatformSim;
  snapshot(): Promise<SimulationState>;
  apply(step: ScenarioStep): Promise<SimulationState>;
  step(): Promise<ScenarioStepResult | null>;
  run(): Promise<SimulationState>;
  dispose(): Promise<void>;
}

type PhysicalWindow = Extract<ScenarioEvent, { kind: "window_added" }>["window"];
type PhysicalDisplay = Omit<SimulationDisplay, "workspace">;

interface ScenarioMember {
  readonly nativeId: string;
  window: PhysicalWindow;
  workspace: string | null;
  floating: boolean;
}

const displaySpecs = (topology: readonly PhysicalDisplay[]): DisplaySpec[] => {
  const hasPrimary = topology.some((display) => display.primary === true);
  return topology.map((display, index) => ({
    id: display.id,
    frame: { ...display.frame },
    workArea: { ...(display.workArea ?? display.frame) },
    scale: display.scale ?? 1,
    primary: display.primary ?? (!hasPrimary && index === 0),
  }));
};

const windowSpec = (window: PhysicalWindow): AddWindowSpec => ({
  ...window.frame,
  title: window.title ?? window.id,
  bundleId: window.bundleId ?? `org.paneform.scenario.${window.id}`,
  role: window.role,
  subrole: window.subrole,
  minimized: window.minimized,
  hidden: window.hidden,
  fullscreen: window.fullscreen,
  personality:
    window.constraints === undefined
      ? { kind: "normal" }
      : { kind: "minMaxClamp", constraints: { ...window.constraints } },
});

function requireMember(members: ReadonlyMap<string, ScenarioMember>, id: string): ScenarioMember {
  const member = members.get(id);
  if (member === undefined) throw new Error(`Unknown scenario window: ${id}`);
  return member;
}

function resolveCommand(command: Command, members: ReadonlyMap<string, ScenarioMember>): Command {
  return "windowId" in command
    ? { ...command, windowId: requireMember(members, command.windowId).nativeId }
    : command;
}

function commandFailure(code: string, message: string) {
  return { code, message };
}

function assertExpectations(
  expected: ScenarioExpectation | undefined,
  state: SimulationState,
): void {
  if (expected === undefined) return;
  for (const key of ["focusedWindow", "focusedWorkspace", "paused", "wmRunning"] as const) {
    if (expected[key] !== undefined && expected[key] !== state[key]) {
      throw new Error(
        `Expected ${key} ${JSON.stringify(expected[key])}, got ${JSON.stringify(state[key])}`,
      );
    }
  }
  const windows = new Map(state.windows.map((window) => [window.id, window]));
  for (const [id, expectation] of Object.entries(expected.windows ?? {})) {
    const window = windows.get(id);
    if (expectation.exists === false) {
      if (window !== undefined) throw new Error(`Expected window ${id} to be absent`);
      continue;
    }
    if (window === undefined) throw new Error(`Expected window ${id} to exist`);
    for (const key of ["workspace", "floating"] as const) {
      if (expectation[key] !== undefined && expectation[key] !== window[key]) {
        throw new Error(
          `Expected ${id}.${key} ${JSON.stringify(expectation[key])}, got ${JSON.stringify(window[key])}`,
        );
      }
    }
    for (const key of ["x", "y", "width", "height"] as const) {
      const value = expectation.frame?.[key];
      if (value !== undefined && value !== window.frame[key])
        throw new Error(`Expected ${id}.frame.${key} ${value}, got ${window.frame[key]}`);
    }
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Public data boundary validates before constructing a simulator.
export async function createScenarioSession(input: unknown): Promise<ScenarioSession> {
  const scenario = parseScenario(input);
  const runtime = createScenarioRuntime();
  const sim = createWebPlatformSim({
    displays: displaySpecs(scenario.state.topology),
    seed: 0x50414e45,
    osRules:
      scenario.simulation === undefined
        ? undefined
        : scenario.simulation.os === "none"
          ? unconstrainedOsRules
          : createMacOsRules(scenario.simulation.os),
  });
  const members = new Map<string, ScenarioMember>();
  const aliases = new Map<string, string>();
  const displayWorkspaces = new Map(
    scenario.state.topology.map((display) => [display.id, display.workspace] as const),
  );
  for (const window of scenario.state.windows) {
    const nativeId = sim.addWindow(windowSpec(window));
    members.set(window.id, {
      nativeId,
      window,
      workspace: window.workspace === undefined ? "1" : window.workspace,
      floating: window.floating ?? false,
    });
    aliases.set(nativeId, window.id);
  }
  sim.focusWindowExternal(
    scenario.state.focusedWindow == null
      ? null
      : requireMember(members, scenario.state.focusedWindow).nativeId,
  );

  let engine: Engine | null = null;
  let focusedWorkspace = scenario.state.focusedWorkspace ?? null;
  let index = 0;
  let failed = false;
  let disposed = false;
  let tail: Promise<void> = Promise.resolve();
  let closing: Promise<void> | undefined;

  const rememberDisplayAssignments = (
    workspaces: readonly { readonly name: string; readonly visibleOnDisplay: string | null }[],
  ): void => {
    displayWorkspaces.clear();
    for (const display of sim.displays()) displayWorkspaces.set(display.id, null);
    for (const workspace of workspaces) {
      if (workspace.visibleOnDisplay !== null)
        displayWorkspaces.set(workspace.visibleOnDisplay, workspace.name);
    }
  };

  const rememberEnginePolicy = async (): Promise<void> => {
    if (engine === null) return;
    const state = await runtime.run(engine.state());
    focusedWorkspace = state.focusedWorkspace;
    for (const window of state.windows) {
      const id = aliases.get(window.id);
      if (id === undefined) continue;
      const member = members.get(id);
      if (member === undefined) continue;
      member.workspace = window.workspace;
      member.floating = window.floating;
    }
    rememberDisplayAssignments(state.workspaces);
  };

  const startEngine = async (hydrate: boolean, initiallyPaused = false): Promise<Engine> => {
    if (engine !== null) return engine;
    const initialLayout = hydrate
      ? {
          windows: [...members.values()].map((member) => ({
            windowId: member.nativeId,
            workspace: member.workspace,
            floating: member.floating,
          })),
          displays: sim.displays().map((display) => ({
            displayId: display.id,
            workspace: displayWorkspaces.get(display.id) ?? null,
          })),
          focusedWorkspace,
        }
      : undefined;
    const options = {
      adapter: sim.adapter,
      clock: runtime.clock,
      configSource: {
        load: () => Effect.succeed(scenario.config ?? {}),
        changes: () => Stream.empty,
      },
      initiallyPaused,
    };
    const next = await runtime.run(
      createEngine(initialLayout === undefined ? options : { ...options, initialLayout }),
    );
    try {
      await runtime.run(next.start());
      engine = next;
      return next;
    } catch (error) {
      await runtime.run(next.stop());
      throw error;
    }
  };

  const stopEngine = async (): Promise<void> => {
    if (engine === null) return;
    const current = engine;
    await rememberEnginePolicy();
    await runtime.run(current.stop());
    engine = null;
  };

  if (scenario.state.wmRunning !== false) {
    await startEngine(true, scenario.state.paused === true);
  }

  const snapshotNow = async (): Promise<SimulationState> => {
    const [observations, topology] = await runtime.run(
      Effect.all([sim.adapter.getWindows(), sim.adapter.getTopology()]),
    );
    let paused = false;
    if (engine !== null) {
      const state = await runtime.run(engine.state());
      paused = state.paused;
      focusedWorkspace = state.focusedWorkspace;
      for (const window of state.windows) {
        const id = aliases.get(window.id);
        const member = id === undefined ? undefined : members.get(id);
        if (member !== undefined) {
          member.workspace = window.workspace;
          member.floating = window.floating;
        }
      }
      rememberDisplayAssignments(state.workspaces);
    }
    const representedWorkspaces = new Set<string>();
    for (const workspace of displayWorkspaces.values())
      if (workspace !== null) representedWorkspaces.add(workspace);
    for (const member of members.values())
      if (member.workspace !== null) representedWorkspaces.add(member.workspace);
    const portableFocusedWorkspace =
      focusedWorkspace !== null && representedWorkspaces.has(focusedWorkspace)
        ? focusedWorkspace
        : null;
    return {
      topology: topology.displays.map((display) => ({
        ...display,
        workspace: displayWorkspaces.get(display.id) ?? null,
      })),
      windows: observations.map((window): SimulationWindow => {
        const id = aliases.get(window.id);
        if (id === undefined) throw new Error(`Unmapped simulation window: ${window.id}`);
        const member = requireMember(members, id);
        return {
          ...member.window,
          id,
          frame: { ...window.frame },
          workspace: member.workspace,
          floating: member.floating,
          minimized: window.minimized,
          hidden: window.hidden,
          fullscreen: window.fullscreen,
        };
      }),
      focusedWorkspace: portableFocusedWorkspace,
      focusedWindow: aliases.get(observations.find((window) => window.focused)?.id ?? "") ?? null,
      paused,
      wmRunning: engine !== null,
    };
  };

  const applyEvent = async (event: ScenarioEvent): Promise<void> => {
    switch (event.kind) {
      case "window_added": {
        const nativeId = sim.addWindow(windowSpec(event.window));
        members.set(event.window.id, {
          nativeId,
          window: event.window,
          workspace: "1",
          floating: false,
        });
        aliases.set(nativeId, event.window.id);
        if (event.focus === true) sim.focusWindowExternal(nativeId);
        break;
      }
      case "window_changed": {
        const member = requireMember(members, event.window.id);
        member.window = { ...member.window, ...event.window };
        sim.updateWindow(member.nativeId, {
          ...windowSpec(member.window),
          frame: event.window.frame,
        });
        break;
      }
      case "window_removed": {
        const member = requireMember(members, event.windowId);
        sim.removeWindow(member.nativeId);
        members.delete(event.windowId);
        aliases.delete(member.nativeId);
        break;
      }
      case "focus_changed":
        sim.focusWindowExternal(
          event.windowId === null ? null : requireMember(members, event.windowId).nativeId,
        );
        break;
      case "topology_changed": {
        const ids = new Set(event.topology.map((display) => display.id));
        for (const id of displayWorkspaces.keys()) if (!ids.has(id)) displayWorkspaces.delete(id);
        for (const id of ids) if (!displayWorkspaces.has(id)) displayWorkspaces.set(id, null);
        sim.setTopology(displaySpecs(event.topology));
        break;
      }
      default:
        sim.signal(event.kind);
    }
    if (engine !== null) await runtime.drain();
  };

  const execute = async (step: ScenarioStep): Promise<SimulationState> => {
    let actualError: { code: string; message: string } | undefined;
    if ("command" in step) {
      const command = parseScenarioCommand(step.command);
      if (command.type === "service") {
        if (command.action === "start") await startEngine(false);
        else if (command.action === "stop") await stopEngine();
        else {
          await stopEngine();
          await startEngine(false);
        }
      } else if (engine === null) {
        actualError = commandFailure("wm_not_running", "window manager is not running");
      } else {
        const outcome = await runtime.run(
          Effect.either(engine.execute(resolveCommand(command, members))),
        );
        if (outcome._tag === "Left") actualError = outcome.left;
      }
      if (actualError?.code !== step.expect?.error) {
        throw new Error(
          actualError === undefined
            ? `Expected command error ${step.expect?.error}, but the command succeeded`
            : `${actualError.code}: ${actualError.message}`,
        );
      }
    } else {
      await applyEvent(step.event);
    }
    const state = await snapshotNow();
    assertExpectations(step.expect, state);
    return state;
  };

  const validateLiveStep = async (step: ScenarioStep): Promise<ScenarioStep> => {
    const state = await snapshotNow();
    const checked = parseScenario({ config: scenario.config, state, steps: [step] });
    const validated = checked.steps?.[0];
    if (validated === undefined)
      throw new Error("Live scenario step was not retained after validation");
    return validated;
  };

  const performStep = async (): Promise<ScenarioStepResult | null> => {
    if (failed) throw new Error("Scenario stopped after a failed step; reset it before continuing");
    const next = scenario.steps?.[index];
    if (next === undefined) return null;
    try {
      const state = await execute(next);
      return { index: index++, step: next, state };
    } catch (error) {
      failed = true;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Step ${index + 1}: ${detail}`, { cause: error });
    }
  };

  const enqueue = <A>(operation: () => Promise<A>, allowDisposed = false): Promise<A> => {
    if (disposed && !allowDisposed)
      return Promise.reject(new Error("Scenario session has been disposed"));
    const result = tail.then(async () => {
      if (disposed && !allowDisposed) throw new Error("Scenario session has been disposed");
      return operation();
    });
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const session: ScenarioSession = {
    get engine() {
      return engine;
    },
    sim,
    snapshot: () => enqueue(snapshotNow),
    apply: (step) =>
      enqueue(async () => {
        const validated = await validateLiveStep(step);
        return execute(validated);
      }),
    step: () => enqueue(performStep),
    run: () =>
      enqueue(async () => {
        while ((await performStep()) !== null) {
          // Scripted steps intentionally run as one FIFO operation.
        }
        return snapshotNow();
      }),
    dispose: () => {
      if (closing !== undefined) return closing;
      disposed = true;
      closing = enqueue(stopEngine, true);
      return closing;
    },
  };
  return session;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Same validated boundary as createScenarioSession.
export async function runScenario(input: unknown): Promise<SimulationState> {
  const session = await createScenarioSession(input);
  try {
    return await session.run();
  } finally {
    await session.dispose();
  }
}
