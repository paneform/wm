<script lang="ts">
  import { quoteCommandToken, type Config } from "@paneform/layout";
  import {
    parseScenario,
    parseScenarioCommand,
    type LayoutScenario,
    type LinkedComparison,
    type ScenarioOsRules,
    type Presentation,
    type ScenarioStep,
    type ScenarioEvent,
    type SimulationState,
    type SimulationWindow,
    type WindowDrag,
  } from "@paneform/layout-browser";
  import { onNavigate } from "$app/navigation";
  import { onMount, untrack } from "svelte";
  import { heroKeyboardChords, keyboardKeys, type HeroCommand } from "$lib/design/tokens.js";
  import { HERO_APPS } from "$lib/hero/hero-model.js";
  import { playgroundDesktopPreset } from "./playground-defaults.js";
  import {
    browserKeyboardScheduler,
    createKeyboardController,
  } from "$lib/hero/keyboard-controller.js";
  import { encodeScenarioFragment, decodeScenarioFragment, MAX_SCENARIO_BYTES } from "./scenario-url.js";
  import { physicalDisplay, physicalWindow } from "./playground-state.js";
  import AdvancedControls from "./AdvancedControls.svelte";
  import ScenarioStage from "./ScenarioStage.svelte";
  import StepEditor from "./StepEditor.svelte";
  import WindowInspector from "./WindowInspector.svelte";
  import FloatingWindowPanel from "./FloatingWindowPanel.svelte";
  import {
    defaultStepDuration,
    insertScenarioSteps,
    mergeRecordedSteps,
    nextPlayWindowId,
    preservesExecutedSteps,
    proportionalRail,
    sceneChanged,
    type PaneStates,
  } from "./scenario-focus.js";
  import LocalConfig from "./LocalConfig.svelte";
  import { configuredKeybindIssues, createModifierTracker, eventToConfiguredCommand } from "./configured-keybinds.js";
  import { createLinkedScenarioClient, type LinkedScenarioClient, type LinkedScenarioState } from "./linked-scenario-client.js";
  import { comparisonForScenario, defaultLinkedComparison } from "./comparison-config.js";
  import type { WindowDragPreview } from "$lib/desktop/window-drag-types.js";
  import { presentWindowDrag } from "./window-drag-animation.js";

  let {
    initialScenario,
    title = "Window manager playground",
    description = "Every desktop action is recorded immediately. Set up windows while Paneform is stopped, then start it to capture the resulting layout.",
  }: { initialScenario: LayoutScenario; title?: string; description?: string } = $props();

  const maximumDocumentLength = 1024 * 1024;
  const suppliedDocument = structuredClone(untrack(() => initialScenario));
  const initialDocument = parseScenario({ ...suppliedDocument, steps: suppliedDocument.steps ?? [] });
  type MacOsDescriptor = Exclude<ScenarioOsRules, "none">;
  let scenario = $state<LayoutScenario>(initialDocument);
  let rememberedLinkedComparison = $state<LinkedComparison>(comparisonForScenario(initialDocument) ?? defaultLinkedComparison);
  let rememberedMacOsRules = $state<MacOsDescriptor>(
    initialDocument.simulation !== undefined && initialDocument.simulation.os !== "none"
      ? initialDocument.simulation.os
      : { kind: "macos" },
  );
  let simulationState = $state<SimulationState>(structuredClone(initialDocument.state));
  let comparisonState = $state<SimulationState | null>(null);
  type Pane = "primary" | "comparison";
  let selectedPane = $state<Pane>("primary");
  let stageRoot = $state<HTMLElement>();
  let documentText = $state(JSON.stringify(initialDocument, null, 2));
  let session: LinkedScenarioClient | null = null;
  let sessionAbort: AbortController | null = null;
  let generation = 0;
  let inputEpoch = $state(0);
  let hashLoadGeneration = 0;
  let playbackToken = 0;
  let stepIndex = $state(-1);
  let running = $state(false);
  let busy = $state(false);
  let complete = $state(false);
  let sessionMatchesCursor = $state(true);
  let error = $state("");
  let notice = $state("Ready.");
  let selectedWindowId = $state<string | null>(null);
  let selectedDisplayId = $state<string | null>(null);
  let panelRevision = $state(0);
  let hasStepDrafts = $state(false);
  let pendingEdits = $state(0);
  let fallbackLink = $state("");
  let openSequence = 0;
  let cancelDelay: (() => void) | null = null;
  let chordAbort: AbortController | null = null;
  let liveDragAbort: AbortController | null = null;
  let dragPreview = $state<WindowDragPreview | null>(null);
  let reducedMotion = $state(false);
  let actionTail: Promise<void> = Promise.resolve();

  const steps = $derived(scenario.steps ?? []);
  const currentStep = $derived(stepIndex >= 0 ? steps[stepIndex] : undefined);
  const selectedWindow = $derived(
    stateForPane(selectedPane).windows.find(({ id }) => id === selectedWindowId) ?? null,
  );
  const presentation = $derived<Presentation>(scenario.presentation ?? {});
  const showWindowSettings = $derived(presentation.showWindowSettings ?? true);
  const linkedComparison = $derived(comparisonForScenario(scenario));
  const comparing = $derived(linkedComparison !== undefined);
  const panes = $derived<{ id: Pane; label: string; subtext: string; state: SimulationState }[]>(linkedComparison
    ? [{ id: "primary", ...linkedComparison.primary, state: simulationState }, { id: "comparison", ...linkedComparison.secondary, state: comparisonState ?? simulationState }]
    : [{ id: "primary", label: "", subtext: "", state: simulationState }]);
  const keybindIssues = $derived(configuredKeybindIssues(scenario.config?.keybinds ?? {}));
  const dragPhaseText = $derived(dragPreview === null ? null : {
    pressed: "Pointer down",
    dragging: "Dragging",
    released: "Released",
    settling: "Applying window rules",
  }[dragPreview.phase]);
  let hoveredStepTitle = $state<string | null>(null);
  let linkTipOpen = $state(false);
  const railGeometry = $derived(
    proportionalRail(steps.map((step) => step.duration ?? defaultStepDuration)),
  );
  const currentStop = $derived(stepIndex + 1);
  const railFill = $derived.by(() => {
    if (playhead === null) return `${railGeometry.positionAt(currentStop)}%`;
    const from = railGeometry.positionAt(playhead.stop);
    return `${from + (railGeometry.positionAt(playhead.stop + 1) - from) * playhead.fraction}%`;
  });
  const railStops = $derived.by(() =>
    railGeometry.stops.map((position, index) => ({
      index,
      position,
      step: index === 0 ? undefined : steps[index - 1],
    })),
  );
  const transportLabel = $derived(running ? "Pause playback" : complete ? "Return to start" : "Play");

  function stepTitle(step: ScenarioStep): string {
    return step.caption ?? ("command" in step ? step.command : step.event.kind);
  }

  function transportAction() {
    if (running) stopPlayback("Playback paused.");
    else if (complete) returnToStart();
    else void play();
  }
  const modifierTracker = createModifierTracker();
  const keyboard = createKeyboardController({
    layout: keyboardKeys,
    get chords() { return scenario.config?.keybinds === undefined ? heroKeyboardChords : []; },
    scheduler: browserKeyboardScheduler(),
    scopeToStage: true,
    dispatch: async (command, source) => {
      if (source === "user") await applySetup({ command: keyboardCommand(command) });
    },
    onError: (cause) => (error = messageFor(cause)),
  });

  function stateForPane(pane: Pane): SimulationState {
    return pane === "comparison" ? comparisonState ?? simulationState : simulationState;
  }

  function updateStates(states: LinkedScenarioState) {
    simulationState = states.primary;
    comparisonState = states.comparison;
    if (states.comparison === null) selectedPane = "primary";
    if (selectedWindowId && !stateForPane(selectedPane).windows.some(({ id }) => id === selectedWindowId))
      selectedWindowId = null;
  }

  function messageFor(cause: unknown): string {
    try {
      return (cause instanceof Error ? cause.message : "The scenario could not be updated.").slice(
        0,
        2_000,
      );
    } catch {
      return "The scenario could not be updated. Check its structure and size.";
    }
  }

  function keyboardCommand(command: HeroCommand): string {
    switch (command.type) {
      case "moveDirection":
        return `window move ${command.direction}`;
      case "focusDirection":
        return `window focus ${command.direction}`;
      case "moveFocusedWindowToWorkspace":
        return `workspace move-window ${quoteCommandToken(command.workspace)}`;
      case "moveFocusedWorkspaceToNextDisplay":
        return "workspace move next";
      case "focusWorkspace":
        return `workspace focus ${quoteCommandToken(command.workspace)}`;
    }
  }

  function handleShortcut(event: KeyboardEvent) {
    if (running || busy || dragPreview || scenario.config?.keybinds === undefined) return;
    if (event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable]:not([contenteditable='false'])")) return;
    const command = eventToConfiguredCommand(event, scenario.config.keybinds, modifierTracker.pressed);
    if (command === null) return;
    event.preventDefault();
    void applySetup({ command });
  }

  function stopPlayback(message?: string) {
    playbackToken += 1;
    running = false;
    stopSweep();
    chordAbort?.abort();
    keyboard.releaseAll({ source: "script" });
    cancelDelay?.();
    cancelDelay = null;
    if (message) notice = message;
  }

  let playhead = $state<{ stop: number; fraction: number } | null>(null);
  let sweepFrame: number | null = null;

  /** Sweeps the rail fill across the playing step's stretch over its known length. */
  function startSweep(stop: number, milliseconds: number, token: number) {
    playhead = { stop, fraction: milliseconds <= 0 ? 1 : 0 };
    if (milliseconds <= 0) return;
    const startedAt = performance.now();
    const tick = (now: number) => {
      sweepFrame = null;
      if (token !== playbackToken || !running) return;
      const fraction = Math.min((now - startedAt) / milliseconds, 1);
      playhead = { stop, fraction };
      if (fraction < 1) sweepFrame = requestAnimationFrame(tick);
    };
    sweepFrame = requestAnimationFrame(tick);
  }

  function stopSweep() {
    if (sweepFrame !== null) cancelAnimationFrame(sweepFrame);
    sweepFrame = null;
    playhead = null;
  }

  function cancelDragPreview() {
    liveDragAbort?.abort();
    liveDragAbort = null;
    dragPreview = null;
  }

  function cancelInteraction(event: KeyboardEvent) {
    if (event.key !== "Escape" || (!chordAbort && !liveDragAbort && !dragPreview)) return;
    event.preventDefault();
    if (chordAbort) stopPlayback("Playback cancelled.");
    cancelDragPreview();
  }

  function delay(milliseconds: number, token: number): Promise<void> {
    return new Promise((resolve) => {
      const timeout = window.setTimeout(finish, milliseconds);
      function finish() {
        window.clearTimeout(timeout);
        if (cancelDelay === finish) cancelDelay = null;
        resolve();
      }
      cancelDelay = finish;
      if (token !== playbackToken) finish();
    });
  }

  async function replaceSession(
    nextScenario: LayoutScenario,
    message = "Scenario loaded.",
    resetMacOsMemory = false,
  ): Promise<boolean> {
    hashLoadGeneration += 1;
    const nextGeneration = ++generation;
    inputEpoch += 1;
    cancelDragPreview();
    sessionAbort?.abort();
    const abort = new AbortController();
    sessionAbort = abort;
    stopPlayback();
    busy = true;
    notice = "Loading playground...";
    error = "";
    const previous = session;
    let candidate: LinkedScenarioClient | null = null;
    session = null;
    try {
      await previous?.dispose().catch(() => undefined);
      if (nextGeneration !== generation) return false;
      candidate = await createLinkedScenarioClient(
        $state.snapshot(nextScenario),
        abort.signal,
      );
      const nextState = await candidate.snapshot();
      if (nextGeneration !== generation) {
        await candidate.dispose().catch(() => undefined);
        return false;
      }
      session = candidate;
      candidate = null;
      scenario = nextScenario;
      if (nextScenario.simulation !== undefined && nextScenario.simulation.os !== "none")
        rememberedMacOsRules = nextScenario.simulation.os;
      else if (resetMacOsMemory) rememberedMacOsRules = { kind: "macos" };
      const nextComparison = comparisonForScenario(nextScenario);
      if (nextComparison !== undefined) rememberedLinkedComparison = nextComparison;
      else if (resetMacOsMemory) rememberedLinkedComparison = defaultLinkedComparison;
      updateStates(nextState);
      documentText = JSON.stringify(nextScenario, null, 2);
      stepIndex = -1;
      complete = false;
      sessionMatchesCursor = true;
      notice = message;
      return true;
    } catch (cause) {
      await candidate?.dispose().catch(() => undefined);
      if (nextGeneration === generation) error = messageFor(cause);
      return false;
    } finally {
      if (nextGeneration === generation) {
        busy = false;
      }
    }
  }

  async function loadHash(hash: string) {
    const hashGeneration = ++hashLoadGeneration;
    stopPlayback();
    busy = true;
    notice = "Loading playground...";
    try {
      const shared = await decodeScenarioFragment(hash);
       if (hashGeneration !== hashLoadGeneration) return;
       const loaded = shared ?? structuredClone(initialDocument);
       const next = parseScenario({ ...loaded, steps: loaded.steps ?? [] });
         await replaceSession(
           next,
           shared ? "Shared scenario loaded from this URL." : "Playground ready.",
           true,
         );
    } catch (cause) {
      if (hashGeneration === hashLoadGeneration) {
        error = messageFor(cause);
        busy = false;
        notice = "This scenario link could not be loaded.";
      }
    }
  }

  async function applyLive(step: ScenarioStep, current = session): Promise<LinkedScenarioState | null> {
    if (!current || current !== session) return null;
    error = "";
    try {
      const state = await current.apply($state.snapshot(step));
      if (current !== session) return null;
      updateStates(state);
      return state;
    } catch (cause) {
      if (current === session) {
        sessionMatchesCursor = false;
        error = messageFor(cause);
        try {
          const updated = await current.snapshot();
          if (current === session) updateStates(updated);
        } catch {
          // Keep the last usable state if the worker itself failed.
        }
      }
      return null;
    }
  }

  async function performSetup(stepsToRecord: readonly ScenarioStep[]): Promise<boolean> {
    if (running || busy) return false;
    if (hasStepDrafts) {
      notice = "Apply your step changes before changing the desktop.";
      return false;
    }
    stopPlayback();
    if (!sessionMatchesCursor) {
      notice = "A failed step may have changed the desktop. Return to start or apply step changes before recording more actions.";
      return false;
    }
    const current = session;
    const expectedGeneration = generation;
    let before: PaneStates = { primary: simulationState, comparison: comparisonState };
    const attempted: ScenarioStep[] = [];
    for (const step of stepsToRecord) {
      const after = await applyLive(step, current);
      if (!after || current !== session || expectedGeneration !== generation) return false;
      if (sceneChanged(before, after)) attempted.push(step);
      before = after;
    }
    if (attempted.length === 0) return true;
    const expectedScenario = $state.snapshot(scenario);
    const next = insertScenarioSteps(expectedScenario, stepIndex, attempted);
    try {
      scenario = mergeRecordedSteps($state.snapshot(scenario), expectedScenario, next.scenario);
    } catch (cause) {
      sessionMatchesCursor = false;
      throw cause;
    }
    documentText = JSON.stringify(scenario, null, 2);
    stepIndex = next.index;
    complete = stepIndex === (scenario.steps?.length ?? 0) - 1;
    notice = `Action recorded as step ${stepIndex + 1}.`;
    return true;
  }

  function enqueueSetup<T>(operation: () => Promise<T>): Promise<T | undefined> {
    const epoch = inputEpoch;
    pendingEdits += 1;
    const result = actionTail.then(async () => {
        try { if (epoch === inputEpoch) return await operation(); }
      catch (cause) { error = messageFor(cause); }
      finally { pendingEdits -= 1; }
    });
    actionTail = result.then(() => undefined);
    return result;
  }

  function applySetup(step: ScenarioStep): Promise<void> {
    return enqueueSetup(() => performSetup([step])).then(() => undefined);
  }

  function previewManualDrag(preview: WindowDragPreview | null, epoch: number) {
    if (epoch !== inputEpoch || busy || running || chordAbort) return;
    dragPreview = preview;
  }

  async function dragWindow(gesture: WindowDrag, epoch: number) {
    if (epoch !== inputEpoch || busy || running || liveDragAbort) return;
    const abort = new AbortController();
    const expectedGeneration = generation;
    const current = session;
    liveDragAbort = abort;
    try {
      await presentWindowDrag(gesture, {
        signal: abort.signal,
        animate: presentation.animate !== false && !reducedMotion,
        live: true,
        onPreview: (preview) => {
          if (liveDragAbort === abort && expectedGeneration === generation && epoch === inputEpoch && current === session)
            dragPreview = preview;
        },
        submit: async () => {
          const applied = await enqueueSetup(() => performSetup([{
            event: { kind: "window_dragged", ...gesture },
            caption: `Drag ${simulationState.windows.find(({ id }) => id === gesture.windowId)?.title ?? gesture.windowId}.`,
          }]));
          if (!applied) abort.abort();
        },
      });
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError") && current === session) error = messageFor(cause);
    } finally {
      if (liveDragAbort === abort) {
        liveDragAbort = null;
        if (expectedGeneration === generation && epoch === inputEpoch && current === session) dragPreview = null;
      }
    }
  }

  async function advance(): Promise<boolean> {
    if (!session || complete || busy || !sessionMatchesCursor) return false;
    const current = session;
    const expectedGeneration = generation;
    const nextIndex = stepIndex + 1;
    const step = steps[nextIndex];
    if (!step) {
      complete = true;
      stopPlayback("Scenario complete.");
      return false;
    }
    busy = true;
    const abort = new AbortController();
    chordAbort = abort;
    let state: LinkedScenarioState | null = null;
    let submitted = false;
    const submit = async () => {
      if (abort.signal.aborted || expectedGeneration !== generation || current !== session) return;
      submitted = true;
      state = await applyLive(step, current);
    };
    try {
      const requested = "command" in step ? parseScenarioCommand(step.command) : null;
      const chord = requested && heroKeyboardChords.find((candidate) => JSON.stringify(parseScenarioCommand(keyboardCommand(candidate.command))) === JSON.stringify(requested));
      if ("event" in step && step.event.kind === "window_dragged") {
        await presentWindowDrag(step.event, {
          signal: abort.signal,
          animate: presentation.animate !== false && !reducedMotion,
          onPreview: (preview) => {
            if (chordAbort === abort && expectedGeneration === generation && current === session) dragPreview = preview;
          },
          submit,
        });
      } else if (chord && presentation.animate !== false && presentation.showKeyboard !== false) {
        await keyboard.chord({ keys: chord.keys, preHold: 60, hold: 200, source: "script", signal: abort.signal, onTrigger: submit });
      } else {
        await submit();
      }
    } catch (cause) {
      if (!abort.signal.aborted && current === session) error = messageFor(cause);
    } finally {
      if (chordAbort === abort) chordAbort = null;
      if (expectedGeneration === generation) busy = false;
    }
    if (expectedGeneration !== generation || current !== session || (!submitted && abort.signal.aborted)) return false;
    if (!state) {
      stopPlayback("Playback stopped at the failing step.");
      return false;
    }
    stepIndex = nextIndex;
    complete = nextIndex === steps.length - 1;
    notice = complete ? "Scenario complete." : `Step ${nextIndex + 1} of ${steps.length}.`;
    return true;
  }

  async function play() {
    if (running) {
      stopPlayback("Playback paused.");
      return;
    }
    running = true;
    complete = false;
    const token = ++playbackToken;
    while (token === playbackToken) {
      const nextIndex = stepIndex + 1;
      const step = steps[nextIndex];
      if (!step) break;
      const gesture = stepEventDuration(step) * Number(presentation.animate !== false);
      const hold = presentation.animate === false ? 0 : step.duration ?? defaultStepDuration;
      startSweep(nextIndex, gesture + hold, token);
      if (!(await advance()) || token !== playbackToken) break;
      if (complete) break;
      await delay(hold, token);
      stopSweep();
    }
    if (token === playbackToken) {
      stopSweep();
      running = false;
    }
  }

  /** Presentation length of a step's own animation before its hold time. */
  function stepEventDuration(step: ScenarioStep): number {
    return "event" in step && step.event.kind === "window_dragged" ? step.event.duration : 0;
  }

  type PipStatus = "done" | "pending" | "idle";

  /** Pips resolve when the playhead reaches them, not when the step applies. */
  function pipStatus(index: number): PipStatus {
    if (playhead !== null && playhead.fraction < 1 && index === playhead.stop + 1) return "pending";
    return index <= currentStop ? "done" : "idle";
  }

  function returnToStart() {
    void replaceSession(
      scenario,
      "Returned to the starting layout. New actions will be recorded before the first step.",
    );
  }

  /** Scrubbing rebuilds the session from the authored start and replays silently. */
  async function seekTo(target: number) {
    if (running || busy || dragPreview || hasStepDrafts || pendingEdits > 0 || !sessionMatchesCursor || !session) return;
    const clamped = Math.min(Math.max(target, 0), steps.length - 1);
    if (clamped === stepIndex) return;
    busy = true;
    try {
      const rebuilt = await replaceSession(scenario, `Jumped to step ${clamped + 1} of ${steps.length}.`);
      if (!rebuilt) return;
      const current = session;
      for (let index = 0; index <= clamped; index += 1) {
        const step = steps[index];
        if (!step) return;
        const state = await applyLive(step, current);
        if (!state || current !== session) return;
        stepIndex = index;
      }
      complete = clamped === steps.length - 1;
    } finally {
      busy = false;
    }
  }

  function rebase() {
    if (comparing || dragPreview) return;
    const next = parseScenario({
      ...scenario,
      state: $state.snapshot(simulationState),
      steps: [],
    });
    void replaceSession(next, "Current layout is the new start; prior steps were cleared.");
  }

  async function changeSteps(nextSteps: readonly ScenarioStep[]): Promise<boolean> {
    try {
      const next = parseScenario({ ...scenario, steps: nextSteps });
      if (preservesExecutedSteps(steps, nextSteps, stepIndex, sessionMatchesCursor)) {
        scenario = next;
        complete = stepIndex >= 0 && stepIndex === nextSteps.length - 1;
        documentText = JSON.stringify(next, null, 2);
        notice = "Steps updated. Continue from the current layout.";
        return true;
      }
      return await replaceSession(next, "Steps changed. Playback reset to the starting layout.");
    } catch (cause) {
      error = messageFor(cause);
      return false;
    }
  }

  async function applyImportedConfig(config: Config): Promise<boolean> {
    if (hasStepDrafts || running || busy || dragPreview || pendingEdits > 0) {
      notice = "Pause playback and apply step changes before loading config.";
      return false;
    }
    const next = parseScenario({ ...scenario, config });
    return replaceSession(next, "Local config loaded. Playback reset; click the desktop to use its hotkeys.");
  }

  function updatePresentation(nextPresentation: Presentation) {
    if (dragPreview) return;
    try {
      const next = parseScenario({ ...scenario, presentation: nextPresentation });
      if (JSON.stringify(nextPresentation.comparison) !== JSON.stringify(presentation.comparison)) {
        if (hasStepDrafts || running || busy || pendingEdits > 0) {
          notice = "Pause playback and apply step changes before linking simulations.";
          return;
        }
        void replaceSession(next, "Linked simulations updated. Playback reset; recorded steps kept.");
        return;
      }
      scenario = next;
      panelRevision += 1;
      documentText = JSON.stringify(scenario, null, 2);
    } catch (cause) {
      error = messageFor(cause);
    }
  }

  function updateSimulation(os: ScenarioOsRules | undefined) {
    if (hasStepDrafts || running || busy || dragPreview || pendingEdits > 0) {
      notice = "Pause playback and apply step changes before changing simulation.";
      return;
    }
    try {
      const next = parseScenario({
        ...scenario,
        simulation: os === undefined ? undefined : { os },
      });
      void replaceSession(next, "Simulation changed. Playback reset to the starting layout.");
    } catch (cause) {
      error = messageFor(cause);
    }
  }

  async function service(action: "start" | "stop") {
    if (dragPreview) return;
    await applySetup({ command: `service ${action}` });
  }

  async function togglePause() {
    if (dragPreview) return;
    await applySetup({ command: simulationState.paused ? "resume" : "pause" });
  }

  async function addDisplay() {
    if (dragPreview) return;
    const state = simulationState;
    const x = Math.max(0, ...state.topology.map(({ frame }) => frame.x + frame.width));
    let suffix = 1;
    while (state.topology.some(({ id }) => id === `display:extra-${suffix}`)) suffix += 1;
    const id = `display:extra-${suffix}`;
    const used = new Set([...state.topology.map((display) => display.workspace), ...state.windows.map((window) => window.workspace ?? "1")]);
    let workspace = 2;
    while (used.has(String(workspace))) workspace += 1;
    const display = { ...playgroundDesktopPreset, id, workspace: String(workspace), primary: false, frame: { ...playgroundDesktopPreset.frame, x }, workArea: { ...playgroundDesktopPreset.workArea, x } };
    await applySetup({ event: { kind: "topology_changed", topology: [...state.topology, display].map(physicalDisplay) } });
    if (simulationState.topology.some((item) => item.id === id)) updatePresentation({ ...presentation, devices: { ...presentation.devices, [id]: "display" } });
  }

  async function removeDisplay(id: string) {
    if (dragPreview) return;
    if (simulationState.topology.length <= 1) return;
    const state = simulationState;
    const { [id]: _removed, ...devices } = presentation.devices ?? {};
    const remaining = state.topology.filter((display) => display.id !== id);
    const topology = remaining.map((display, index) => ({ ...display, primary: index === 0 }));
    await applySetup({ event: { kind: "topology_changed", topology: topology.map(physicalDisplay) } });
    if (!simulationState.topology.some((item) => item.id === id)) updatePresentation({ ...presentation, devices });
  }

  async function focusWindow(id: string) {
    const title = simulationState.windows.find((window) => window.id === id)?.title ?? id;
    await applySetup({ event: { kind: "focus_changed", windowId: id }, caption: `Focus ${title}.` });
  }

  function selectWindow(id: string, displayId?: string, pane: Pane = "primary") {
    selectedPane = pane;
    selectedWindowId = id;
    selectedDisplayId = displayId ?? null;
    if (running || busy) return;
    void focusWindow(id);
  }

  function closeInspector() {
    const id = selectedWindowId;
    updatePresentation({ ...presentation, showWindowSettings: false });
    const paneRoot = stageRoot?.querySelector<HTMLElement>(`[data-simulation-pane="${selectedPane}"]`);
    const windowElement = [...(paneRoot?.querySelectorAll<HTMLElement>("[data-window-id]") ?? [])].find((element) => element.dataset.windowId === id);
    windowElement?.querySelector<HTMLElement>(".window-titlebar")?.focus({ preventScroll: true });
  }

  async function changeWindow(id: string, frame: SimulationWindow["frame"], pane: Pane = "primary") {
    if (dragPreview) return;
    const window = stateForPane(pane).windows.find((candidate) => candidate.id === id);
    if (!window) return;
    await applySetup({ event: { kind: "window_changed", window: { ...physicalWindow(window), frame } } });
  }

  async function closeWindow(id: string) {
    if (dragPreview) return;
    await applySetup({ event: { kind: "window_removed", windowId: id } });
  }

  async function activate(appId: string, displayId?: string, pane: Pane = "primary") {
    if (dragPreview) return;
    if (appId === "com.paneform.wm") {
      await service("start");
      return;
    }
    await enqueueSetup(async () => {
      const state = stateForPane(pane);
      const existing = state.windows.find(({ bundleId }) => bundleId === appId);
      if (existing) {
        const title = existing.title ?? existing.id;
        await performSetup([{ event: { kind: "focus_changed", windowId: existing.id }, caption: `Focus ${title}.` }]);
        return;
      }
      const display = state.topology.find(({ id }) => id === displayId) ?? state.topology[0];
      if (!display) return;
      const workArea = display.workArea ?? display.frame;
      const allocated = nextPlayWindowId(scenario, state.windows.map(({ id }) => id), openSequence);
      openSequence = allocated.sequence;
      const offset = ((openSequence - 1) % 6) * 36;
      const app = HERO_APPS.find(({ bundleId }) => bundleId === appId);
      const maxWidth = app && "maxWidth" in app ? app.maxWidth : undefined;
      const width = Math.max(1, Math.min(maxWidth ?? 900, workArea.width - 80));
      const height = Math.max(1, Math.min(620, workArea.height - 80));
      const added: SimulationWindow = { id: allocated.id, title: app?.title ?? "Window", bundleId: appId, frame: { x: workArea.x + Math.min(40 + offset, Math.max(0, workArea.width - width)), y: workArea.y + Math.min(40 + offset, Math.max(0, workArea.height - height)), width, height } };
      const window = maxWidth === undefined ? added : { ...added, constraints: { maxWidth } };
      const launchSteps: ScenarioStep[] = [];
      if (state.wmRunning !== false && !state.paused && display.workspace !== null && state.focusedWorkspace !== display.workspace)
        launchSteps.push({ command: `workspace focus ${quoteCommandToken(display.workspace)}` });
      launchSteps.push({ event: { kind: "window_added", window: physicalWindow(window), focus: true }, caption: `Open ${window.title ?? "Window"}` });
      await performSetup(launchSteps);
    });
  }

  async function focusWorkspace(name: string, displayId?: string) {
    if (dragPreview) return;
    if (!simulationState.topology.some((display) => display.id === displayId) && displayId !== undefined) return;
    await applySetup({ command: `workspace focus ${quoteCommandToken(name)}` });
  }

  async function saveWindow(window: SimulationWindow) {
    if (dragPreview) return;
    await applySetup({ event: { kind: "window_changed", window: physicalWindow(window) } });
  }

  function loadDocument() {
    if (dragPreview) return;
    try {
      if (new TextEncoder().encode(documentText).byteLength > MAX_SCENARIO_BYTES)
        throw new Error("Scenario JSON must be 1 MiB or smaller.");
      const loaded = parseScenario(JSON.parse(documentText));
      const next = parseScenario({ ...loaded, steps: loaded.steps ?? [] });
      void replaceSession(next, undefined, true);
    } catch (cause) {
      error = messageFor(cause);
      notice = "Fix the JSON or validation error, then load it again.";
    }
  }

  function exportScenario(): LayoutScenario {
    return $state.snapshot(scenario);
  }

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(exportScenario(), null, 2));
      notice = "Validated scenario JSON copied.";
    } catch (cause) {
      error = messageFor(cause);
    }
  }

  async function shareLink() {
    try {
      const fragment = await encodeScenarioFragment(exportScenario());
      const link = `${location.origin}/wm/play/${fragment}`;
      fallbackLink = link;
      await navigator.clipboard.writeText(link);
      notice = "Share link copied. Its compressed contents are not private.";
    } catch (cause) {
      error = messageFor(cause);
      notice = "Copy the read-only link below if clipboard access is unavailable.";
    }
  }

  function handleVisibility() {
    if (document.hidden) modifierTracker.reset();
    if (document.hidden && (running || busy)) stopPlayback("Playback paused while this tab is hidden.");
    if (document.hidden) cancelDragPreview();
  }

  onNavigate(({ to }) => {
    if (to?.url.pathname === location.pathname) void loadHash(to.url.hash);
  });

  onMount(() => {
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => (reducedMotion = motionQuery.matches);
    updateMotion();
    motionQuery.addEventListener("change", updateMotion);
    const detachKeyboard = stageRoot ? keyboard.attach(stageRoot) : undefined;
    const handleHash = () => void loadHash(location.hash);
    window.addEventListener("keydown", modifierTracker.keydown, true);
    window.addEventListener("keydown", cancelInteraction, true);
    window.addEventListener("keyup", modifierTracker.keyup, true);
    window.addEventListener("blur", modifierTracker.reset);
    window.addEventListener("pagehide", modifierTracker.reset);
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("hashchange", handleHash);
    window.addEventListener("popstate", handleHash);
    handleHash();
    return () => {
      generation += 1;
      hashLoadGeneration += 1;
      sessionAbort?.abort();
      cancelDragPreview();
      stopPlayback();
      detachKeyboard?.();
      keyboard.stop();
      modifierTracker.reset();
      window.removeEventListener("keydown", modifierTracker.keydown, true);
      window.removeEventListener("keydown", cancelInteraction, true);
      window.removeEventListener("keyup", modifierTracker.keyup, true);
      window.removeEventListener("blur", modifierTracker.reset);
      window.removeEventListener("pagehide", modifierTracker.reset);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("hashchange", handleHash);
      window.removeEventListener("popstate", handleHash);
      motionQuery.removeEventListener("change", updateMotion);
      const current = session;
      session = null;
      void current?.dispose().catch(() => undefined);
    };
  });
</script>

<svelte:window onclick={() => (linkTipOpen = false)} />

<section class="player" aria-labelledby="play-heading" aria-busy={busy}>
  <header class="intro" class:comparing={comparing}><div><p class="eyebrow">Paneform playground</p><h1 id="play-heading">{linkedComparison?.primary.label && linkedComparison.secondary.label ? `${linkedComparison.primary.label} vs ${linkedComparison.secondary.label}` : title}</h1></div>{#if !comparing}<p>{description}</p>{/if}</header>
  <div class="showcase">
    <div class="simulation-panes" class:comparing bind:this={stageRoot}>
      {#key inputEpoch}{#each panes as pane (pane.id)}
        {@const renderedInputEpoch = inputEpoch}
        <div class="simulation-pane" data-simulation-pane={pane.id}>
          {#if comparing && (pane.label || pane.subtext)}<header class="pane-heading">{#if pane.label}<h2>{pane.label}</h2>{/if}{#if pane.subtext}<p>{pane.subtext}</p>{/if}</header>{/if}
          {#if comparing && pane.id === "comparison"}
            <button class="link-indicator" class:open={linkTipOpen} type="button" aria-label="inputs are identical, but OS rules impact outcomes" aria-expanded={linkTipOpen} onclick={(event) => { event.stopPropagation(); linkTipOpen = !linkTipOpen; }} onblur={() => (linkTipOpen = false)} onkeydown={(event) => { if (event.key === "Escape") linkTipOpen = false; }}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
              <span class="tooltip" aria-hidden="true">inputs are identical, but OS rules impact outcomes</span>
            </button>
          {/if}
          <ScenarioStage
            state={pane.state}
            {presentation}
            controller={keyboard}
            keybinds={scenario.config?.keybinds}
            attachKeyboard={false}
            label={comparing ? `${pane.label || (pane.id === "primary" ? "Left simulation" : "Right simulation")} interactive displays` : "Interactive scenario displays"}
            interactive={!running && !busy && sessionMatchesCursor}
            selectable
            {dragPreview}
            onactivate={(app, display) => void activate(app, display, pane.id)}
            onselectwindow={(id, display) => selectWindow(id, display, pane.id)}
            onclosewindow={(id) => void closeWindow(id)}
            onmovewindow={(id, point) => { const window = pane.state.windows.find((item) => item.id === id); if (window) return changeWindow(id, { ...window.frame, ...point }, pane.id); }}
            onresizewindow={(id, frame) => changeWindow(id, frame, pane.id)}
            onpreviewdrag={(preview) => previewManualDrag(preview, renderedInputEpoch)}
            ondragwindow={(gesture) => dragWindow(gesture, renderedInputEpoch)}
            onfocusworkspace={(name, display) => void focusWorkspace(name, display)}
            onshortcut={handleShortcut}
          />
        </div>
      {/each}{/key}
    </div>
    <div class="player-bar">
      <p class="step-title" aria-live="polite">{dragPhaseText ?? hoveredStepTitle ?? currentStep?.caption ?? "Starting layout"}</p>
      <div class="transport" role="group" aria-label="Playback">
        <button class="icon-control" type="button" disabled={(busy && !running) || (!running && dragPreview !== null) || steps.length === 0 || hasStepDrafts || pendingEdits > 0 || !sessionMatchesCursor} aria-label={transportLabel} title={transportLabel} onclick={transportAction}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            {#if running}<path d="M9 5v14M15 5v14" />
            {:else if complete}<path d="M4 10a8 8 0 1 1 1.5 7M4 4v6h6" />
            {:else}<path d="m9 5 11 7-11 7Z" />{/if}
          </svg>
        </button>
        {#if steps.length > 0}
          <span class="bookend" aria-hidden="true">1</span>
          <div class="rail" role="group" aria-label="Scenario steps" style:--rail-fill={railFill}>
            {#each railStops as stop (stop.index)}
              <button class="pip" class:done={pipStatus(stop.index) === "done"} class:pending={pipStatus(stop.index) === "pending"} style:left={`${stop.position}%`} type="button" disabled={stop.step !== undefined && (busy || running || dragPreview !== null || hasStepDrafts || pendingEdits > 0 || !sessionMatchesCursor)} aria-label={stop.step === undefined ? "Return to the starting layout" : `Step ${stop.index}: ${stepTitle(stop.step)}`} aria-current={stop.index === currentStop ? "step" : undefined} onmouseenter={() => (hoveredStepTitle = stop.step === undefined ? "Starting layout" : stepTitle(stop.step))} onmouseleave={() => (hoveredStepTitle = null)} onfocus={() => (hoveredStepTitle = stop.step === undefined ? "Starting layout" : stepTitle(stop.step))} onblur={() => (hoveredStepTitle = null)} onclick={stop.step === undefined ? returnToStart : () => void seekTo(stop.index - 1)}></button>
            {/each}
          </div>
          <span class="bookend" aria-hidden="true">{steps.length}</span>
        {/if}
      </div>
    </div>
  </div>

  {#if showWindowSettings && selectedWindow}
    <FloatingWindowPanel displayId={selectedDisplayId} scopeSelector={`[data-simulation-pane="${selectedPane}"]`} refreshKey={inputEpoch + panelRevision} onclose={closeInspector}>
      <WindowInspector window={selectedWindow} editable={!busy && !running && !dragPreview} onsave={saveWindow} onclose={closeInspector} />
    </FloatingWindowPanel>
  {/if}

  <div class="controls" aria-label="Playground controls">
    {#if stepIndex >= 0 && !comparing}<button type="button" onclick={rebase}>Use current layout as new start</button>{/if}
    <button type="button" disabled={dragPreview !== null} aria-pressed={showWindowSettings} onclick={() => updatePresentation({ ...presentation, showWindowSettings: !showWindowSettings })}>{showWindowSettings ? "Hide" : "Show"} window settings</button>
    <label class="window-picker" for="inspect-window">Window{linkedComparison ? ` on ${selectedPane === "primary" ? linkedComparison.primary.label || "left simulation" : linkedComparison.secondary.label || "right simulation"}` : ""}<select id="inspect-window" disabled={dragPreview !== null} value={selectedWindowId ?? ""} onchange={(event) => { selectedWindowId = event.currentTarget.value || null; selectedDisplayId = null; }}><option value="">Inspect a window</option>{#each stateForPane(selectedPane).windows as window (window.id)}<option value={window.id}>{window.title ?? window.id}</option>{/each}</select></label>
    <span class="status" aria-live="polite">{notice}</span>
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <LocalConfig onload={applyImportedConfig} disabled={busy || running || dragPreview !== null || hasStepDrafts || pendingEdits > 0} />
  <p class="draft-notice">Click the desktop to use {scenario.config?.keybinds === undefined ? "the demo hotkeys" : "your configured hotkeys"}. Keyboard shortcuts are inactive while editing text or playing a scenario.</p>
  {#if keybindIssues.length}
    <details class="keybind-issues"><summary>{keybindIssues.length} hotkey{keybindIssues.length === 1 ? "" : "s"} unavailable in this browser</summary><ul>{#each keybindIssues as issue}<li><code>{issue.chord}</code>: {issue.reason}</li>{/each}</ul></details>
  {/if}

  <AdvancedControls
    {presentation}
    osRules={scenario.simulation?.os}
    {rememberedMacOsRules}
    comparison={linkedComparison}
    {rememberedLinkedComparison}
    state={simulationState}
    busy={busy || running || dragPreview !== null || pendingEdits > 0 || hasStepDrafts}
    onpresentationchange={updatePresentation}
    onsimulationchange={updateSimulation}
    onstart={() => void service("start")}
    onstop={() => void service("stop")}
    onpause={() => void togglePause()}
    onadddisplay={() => void addDisplay()}
    onremovedisplay={(id) => void removeDisplay(id)}
  />

    <div class="authoring"><StepEditor {scenario} sessionKey={inputEpoch} disabled={busy || running || dragPreview !== null || pendingEdits > 0} onchange={changeSteps} ondirtychange={(dirty) => (hasStepDrafts = dirty)} /></div>
  {#if hasStepDrafts}<p class="draft-notice">Finish building and apply your step changes before playback.</p>{/if}

  <details class="editor">
    <summary>JSON and sharing</summary>
    <p>The fragment never leaves this browser by itself. Compression is not privacy: window titles, configuration, and captions are visible to link recipients.</p>
    <label for="scenario-json">Scenario JSON</label><textarea id="scenario-json" disabled={dragPreview !== null} bind:value={documentText} maxlength={maximumDocumentLength} spellcheck="false"></textarea>
    <div class="editor-actions"><button class="primary" type="button" disabled={busy || dragPreview !== null} onclick={loadDocument}>Load scenario</button><button type="button" disabled={dragPreview !== null} onclick={() => void copyJson()}>Copy JSON</button><button type="button" disabled={dragPreview !== null} onclick={() => void shareLink()}>Copy share link</button><a href="/wm/play/scenario.schema.json">JSON Schema</a></div>
    {#if fallbackLink}<label for="share-link">Share link</label><input id="share-link" class="share-link" readonly value={fallbackLink} onclick={(event) => event.currentTarget.select()} />{/if}
  </details>
</section>

<style>
  .player { width: min(100% - 2 * clamp(0.5rem, 2vw, 2rem), 120rem); margin-inline: auto; padding-block: 1rem; }
  .intro { display: grid; grid-template-columns: minmax(0, 1fr) minmax(18rem, 0.8fr); align-items: end; gap: 3rem; margin-bottom: 1.5rem; } .intro.comparing { grid-template-columns: minmax(0, 1fr); text-align: center; } .eyebrow { margin: 0 0 0.6rem; color: var(--rp-foam); font-size: var(--type-size-label); font-weight: 650; letter-spacing: var(--type-tracking-label); text-transform: uppercase; } h1 { margin: 0; font-size: clamp(2rem, 4vw, 3.5rem); line-height: 1; } .intro > p { margin: 0; color: var(--color-page-secondary); }
  .showcase { overflow: hidden; border: 1px solid var(--color-line-default); border-radius: 1rem; background: radial-gradient(circle at 50% 20%, color-mix(in srgb, var(--rp-iris) 10%, transparent), transparent 55%), var(--color-surface-base); }
  .simulation-panes.comparing { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .simulation-pane { min-width: 0; position: relative; }
  .comparing .simulation-pane + .simulation-pane { border-inline-start: 1px solid var(--color-line-default); }
  .link-indicator { position: absolute; z-index: 2; inset-inline-start: 0; top: 50%; transform: translate(-50%, -50%); display: grid; place-items: center; width: 1.9rem; height: 1.9rem; min-height: 0; padding: 0; border-radius: 999px; color: var(--color-page-secondary); }
  .link-indicator:hover { color: var(--color-page-foreground); }
  .link-indicator svg { display: block; width: 1rem; height: 1rem; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .link-indicator .tooltip { position: absolute; top: calc(100% + 0.45rem); left: 50%; transform: translateX(-50%); border: 1px solid var(--color-line-default); border-radius: var(--radius-control); padding: 0.4rem 0.6rem; background: var(--color-surface-raised); color: var(--color-page-foreground); font: 500 0.75rem/1.35 var(--type-family-system); text-align: center; width: max-content; max-width: 13rem; box-shadow: 0 0.25rem 0.875rem color-mix(in srgb, black 18%, transparent); opacity: 0; visibility: hidden; pointer-events: none; transition: opacity var(--motion-feedback) var(--easing-standard), visibility var(--motion-feedback) var(--easing-standard); }
  .link-indicator:hover .tooltip, .link-indicator:focus-visible .tooltip, .link-indicator:active .tooltip, .link-indicator.open .tooltip { opacity: 1; visibility: visible; }
  .pane-heading { padding: 1rem 1rem 0; text-align: center; }
  .pane-heading h2 { margin: 0; font-size: clamp(1.2rem, 2.5vw, 1.8rem); letter-spacing: -0.03em; overflow-wrap: anywhere; }
  .pane-heading p { margin: 0.35rem 0 0; color: var(--color-page-secondary); font-size: 0.8rem; }
  @media (max-width: 48rem) { .simulation-panes.comparing { grid-template-columns: minmax(0, 1fr); } .comparing .simulation-pane + .simulation-pane { border-inline-start: 0; border-block-start: 1px solid var(--color-line-default); } .link-indicator { inset-inline-start: 50%; top: 0; transform: translate(-50%, -50%); } }
  .player-bar { display: grid; gap: 0.1rem; border-top: 1px solid var(--color-line-default); padding: 0.55rem 0.9rem 0.6rem; background: color-mix(in srgb, var(--color-surface-raised) 45%, transparent); }
  .step-title { margin: 0; overflow: hidden; white-space: nowrap; text-align: center; text-overflow: ellipsis; font-size: 0.9rem; font-weight: 650; }
  .transport { display: flex; align-items: center; gap: 0.45rem; }
  .icon-control { display: inline-grid; place-items: center; width: var(--control-target); height: var(--control-target); min-width: var(--control-target); min-height: var(--control-target); border: 0; padding: 0; background: none; border-radius: 999px; color: var(--color-page-secondary); cursor: pointer; }
  .icon-control:not(:disabled):hover { background: color-mix(in srgb, var(--color-page-foreground) 8%, transparent); color: var(--color-page-foreground); }
  .icon-control svg { display: block; width: 1.1rem; height: 1.1rem; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .rail { position: relative; flex: 1; height: var(--control-target); min-width: 0; }
  .rail::before { content: ""; position: absolute; inset: 50% 0 auto; height: 2px; transform: translateY(-50%); background: var(--rp-muted); }
  .rail::after { content: ""; position: absolute; inset: 50% auto auto 0; width: var(--rail-fill, 0%); height: 2px; transform: translateY(-50%); border-radius: 999px; background: var(--rp-foam); transition: width var(--motion-feedback) var(--easing-standard); }
  .pip { position: absolute; top: 0; bottom: 0; width: 1.4rem; transform: translateX(-50%); border: 0; padding: 0; background: none; cursor: pointer; }
  .pip::after { content: ""; position: absolute; top: 50%; left: 50%; width: 0.55rem; height: 0.55rem; border-radius: 999px; background: var(--rp-muted); transform: translate(-50%, -50%); transition: background var(--motion-feedback) var(--easing-standard), transform var(--motion-feedback) var(--easing-standard); }
  .pip.pending::after { background: var(--rp-subtle); }
  .pip.done::after { background: var(--rp-foam); }
  .pip:not(:disabled):hover::after { transform: translate(-50%, -50%) scale(1.35); } .pip:disabled { cursor: default; opacity: 1; }
  .bookend { padding-inline: 0.4rem; color: var(--color-page-secondary); font-size: 0.75rem; font-variant-numeric: tabular-nums; }
  code { color: var(--rp-rose); font-size: 0.75rem; }
  .controls, .editor-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 0.6rem; } .controls { margin-block: 1rem; } .status { flex: 1; min-width: 14rem; color: var(--color-page-secondary); text-align: right; }
  button, .editor-actions a { min-height: var(--control-target); border: 1px solid var(--color-line-strong); border-radius: var(--radius-control); padding: 0.6rem 0.85rem; background: var(--color-surface-raised); color: inherit; font-weight: 650; cursor: pointer; } button.primary { border-color: var(--color-action-background); background: var(--color-action-background); color: var(--color-action-foreground); } button:disabled { cursor: not-allowed; opacity: 0.5; }
  .error { border-left: 3px solid var(--rp-love); padding: 0.7rem 1rem; color: var(--rp-love); } .authoring { max-width: 62rem; margin-top: 1.5rem; }
  .window-picker { display: flex; align-items: center; gap: 0.5rem; margin: 0; }
  .window-picker select { max-width: 14rem; min-height: var(--control-target); border: 1px solid var(--color-line-default); border-radius: var(--radius-control); padding: 0.5rem; background: var(--color-surface-raised); color: inherit; }
  .draft-notice { color: var(--color-page-secondary); font-size: 0.85rem; }
  .editor { margin-top: 1.5rem; border-top: 1px solid var(--color-line-default); padding-top: 1rem; } summary { width: fit-content; cursor: pointer; font-weight: 650; } .editor p, label { color: var(--color-page-secondary); font: 0.85rem/1.5 var(--type-family-system); } label { display: block; margin-block: 0.8rem 0.4rem; font-weight: 650; } textarea, .share-link { width: 100%; border: 1px solid var(--color-line-default); border-radius: var(--radius-control); padding: 0.8rem; background: var(--color-surface-base); color: inherit; font-family: var(--type-family-product); } textarea { min-height: 18rem; resize: vertical; } .editor-actions { margin-top: 0.6rem; } .editor-actions a { display: inline-grid; place-items: center; text-decoration: none; }
  :is(button, a, summary, textarea, input):focus-visible { outline: 2px solid var(--color-focus-ring); outline-offset: 2px; }
  @media (max-width: 52rem) { .intro { display: block; } .intro > p { margin-top: 1rem; } .authoring { grid-template-columns: 1fr; } .status { min-width: 100%; text-align: left; } }
  @media (max-width: 38rem) { .player { width: min(100% - 1rem, 88rem); } }
</style>
