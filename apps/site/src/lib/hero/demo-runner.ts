import { isHeroActionEnabled } from "./feature-flags.js";
import type { ActionArbiter } from "./action-arbiter.js";
import { demoTimeline, type DemoCue, type DemoCueAction } from "./demo-timeline.js";
import type { HeroActionResult, HeroSimulation } from "./create-hero-simulation.js";

export interface DemoScheduler {
  now(): number;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export interface DemoPresentationHooks {
  run(cue: DemoCue, options: { signal: AbortSignal; reducedMotion: boolean }): Promise<void>;
  commandReady?(cue: DemoCue, signal: AbortSignal): Promise<void> | null;
  commandExecuting?(cue: DemoCue): void | Promise<void>;
  commandCommitted?(cue: DemoCue): void | Promise<void>;
  cancel?(): void;
  settleFinal?(): void | Promise<void>;
}

export type DemoRunResult =
  | { readonly status: "completed"; readonly activeTime: number }
  | { readonly status: "aborted"; readonly activeTime: number }
  | { readonly status: "paused"; readonly activeTime: number; readonly error: Error };

const defaultScheduler: DemoScheduler = {
  now: () => performance.now(),
  wait: (milliseconds, signal) =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, milliseconds);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timeout);
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    }),
};

export interface DemoRunner {
  run(options?: { reducedMotion?: boolean }): Promise<DemoRunResult>;
  pause(): void;
  abort(reason?: Error): void;
}

function executeAction(
  simulation: HeroSimulation,
  action: DemoCueAction,
): Promise<HeroActionResult | null> {
  switch (action.type) {
    case "activate-app":
      return simulation.activateApp(action.app);
    case "launch-wm":
      return simulation.activateApp("Paneform");
    case "move-direction":
      return simulation.moveDirection(action.direction);
    case "focus-direction":
      return simulation.focusDirection(action.direction);
    case "move-window":
      return simulation.moveFocusedWindowToWorkspace(action.workspace);
    case "connect-display":
      return simulation.connectStudioDisplay();
    case "move-workspace-display":
      return simulation.moveFocusedWorkspaceToNextDisplay();
    case "focus-workspace":
      return simulation.focusWorkspace(action.workspace);
    default:
      return Promise.resolve(null);
  }
}

export function createDemoRunner(options: {
  simulation: HeroSimulation;
  arbiter: ActionArbiter;
  presentation: DemoPresentationHooks;
  scheduler?: DemoScheduler;
  cues?: readonly DemoCue[];
  includeSettings?: boolean;
  onSnapshot?: (snapshot: HeroActionResult["snapshot"]) => void;
}): DemoRunner {
  const scheduler = options.scheduler ?? defaultScheduler;
  const cues = (options.cues ?? demoTimeline).filter(({ action }) =>
    isHeroActionEnabled(action) &&
    !(options.includeSettings === false && action.type === "activate-app" && action.app === "Settings"),
  );
  const duration = cues.reduce((total, cue) => total + cue.end - cue.start, 0);
  let controller: AbortController | null = null;
  let cursor = 0;

  return {
    run: async ({ reducedMotion = false } = {}) => {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      const generation = options.arbiter.beginAutoplay();
      const started = scheduler.now();
      try {
        for (; cursor < cues.length; cursor += 1) {
          const cue = cues[cursor];
          if (!cue) throw new Error("Demo cue is unavailable");
          if (signal.aborted || generation !== options.arbiter.generation())
            throw signal.reason ?? new Error("Autoplay invalidated");
          const presentation = reducedMotion
            ? null
            : options.presentation.run(cue, { signal, reducedMotion }).then(
                () => null,
                (cause: unknown) => cause,
              );
          const commandReady = reducedMotion
            ? null
            : options.presentation.commandReady?.(cue, signal);
          if (commandReady) await commandReady;
          else if (!reducedMotion && cue.triggerOffset > 0)
            await scheduler.wait(cue.triggerOffset, signal);
          await options.presentation.commandExecuting?.(cue);
          const outcome = await options.arbiter.submitScript(generation, () =>
            executeAction(options.simulation, cue.action),
          );
          if (outcome.status !== "completed") throw new Error("Autoplay invalidated");
          if (outcome.value !== null) options.onSnapshot?.(outcome.value.snapshot);
          await options.presentation.commandCommitted?.(cue);
          if (outcome.value !== null && !outcome.value.ok)
            return {
              status: "paused",
              activeTime: scheduler.now() - started,
              error: outcome.value.error,
            };
          cursor += 1;
          if (!reducedMotion) {
            const remaining = cue.end - cue.start - cue.triggerOffset;
            if (remaining > 0) await scheduler.wait(remaining, signal);
            const presentationFailure = await presentation;
            if (presentationFailure !== null) throw presentationFailure;
          }
          cursor -= 1;
        }
        if (reducedMotion) await options.presentation.settleFinal?.();
        return {
          status: "completed",
          activeTime: reducedMotion ? duration : scheduler.now() - started,
        };
      } catch (cause) {
        if (signal.aborted || generation !== options.arbiter.generation())
          return { status: "aborted", activeTime: scheduler.now() - started };
        return {
          status: "paused",
          activeTime: scheduler.now() - started,
          error: cause instanceof Error ? cause : new Error(String(cause)),
        };
      }
    },
    pause: () => {
      options.arbiter.invalidateAutoplay();
      controller?.abort(new Error("Demo paused"));
      options.presentation.cancel?.();
    },
    abort: (reason) => {
      options.arbiter.invalidateAutoplay();
      controller?.abort(reason);
      options.presentation.cancel?.();
    },
  };
}
