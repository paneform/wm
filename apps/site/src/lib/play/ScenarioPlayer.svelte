<script lang="ts">
  import { quoteCommandToken, type Config } from "@paneform/layout";
  import {
    parseScenario,
    parseScenarioCommand,
    type LayoutScenario,
    type ScenarioOsRules,
    type Presentation,
    type ScenarioStep,
    type ScenarioEvent,
    type SimulationState,
    type SimulationWindow,
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
    insertScenarioSteps,
    mergeRecordedSteps,
    nextPlayWindowId,
    preservesExecutedSteps,
  } from "./scenario-focus.js";
  import LocalConfig from "./LocalConfig.svelte";
  import { configuredKeybindIssues, createModifierTracker, eventToConfiguredCommand } from "./configured-keybinds.js";
  import { createScenarioClient, type ScenarioClient } from "./scenario-client.js";

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
  let rememberedMacOsRules = $state<MacOsDescriptor>(
    initialDocument.simulation !== undefined && initialDocument.simulation.os !== "none"
      ? initialDocument.simulation.os
      : { kind: "macos" },
  );
  let simulationState = $state<SimulationState>(structuredClone(initialDocument.state));
  let documentText = $state(JSON.stringify(initialDocument, null, 2));
  let session: ScenarioClient | null = null;
  let sessionAbort: AbortController | null = null;
  let generation = 0;
  let inputEpoch = $state(0);
  let hashLoadGeneration = 0;
  let playbackToken = 0;
  let stepIndex = $state(-1);
  let running = $state(false);
  let busy = $state(false);
  let preservingSetup = $state(false);
  let complete = $state(false);
  let sessionMatchesCursor = true;
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
  let actionTail: Promise<void> = Promise.resolve();

  const steps = $derived(scenario.steps ?? []);
  const currentStep = $derived(stepIndex >= 0 ? steps[stepIndex] : undefined);
  const selectedWindow = $derived(
    simulationState.windows.find(({ id }) => id === selectedWindowId) ?? null,
  );
  const presentation = $derived<Presentation>(scenario.presentation ?? {});
  const keybindIssues = $derived(configuredKeybindIssues(scenario.config?.keybinds ?? {}));
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
    if (running || busy || scenario.config?.keybinds === undefined) return;
    if (event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable]:not([contenteditable='false'])")) return;
    const command = eventToConfiguredCommand(event, scenario.config.keybinds, modifierTracker.pressed);
    if (command === null) return;
    event.preventDefault();
    void applySetup({ command });
  }

  function stopPlayback(message?: string) {
    playbackToken += 1;
    running = false;
    chordAbort?.abort();
    keyboard.releaseAll({ source: "script" });
    cancelDelay?.();
    cancelDelay = null;
    if (message) notice = message;
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
    preserveInputs = false,
    resetMacOsMemory = false,
  ): Promise<boolean> {
    hashLoadGeneration += 1;
    const nextGeneration = ++generation;
    if (!preserveInputs) inputEpoch += 1;
    sessionAbort?.abort();
    const abort = new AbortController();
    sessionAbort = abort;
    stopPlayback();
    busy = true;
    preservingSetup = preserveInputs;
    notice = "Loading playground...";
    error = "";
    const previous = session;
    let candidate: ScenarioClient | null = null;
    session = null;
    try {
      await previous?.dispose().catch(() => undefined);
      if (nextGeneration !== generation) return false;
      candidate = await createScenarioClient(
        $state.snapshot(nextScenario),
        undefined,
        undefined,
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
      simulationState = nextState;
      documentText = JSON.stringify(nextScenario, null, 2);
      stepIndex = -1;
      complete = false;
      sessionMatchesCursor = true;
      selectedWindowId = selectedWindowId && nextState.windows.some(({ id }) => id === selectedWindowId) ? selectedWindowId : null;
      notice = message;
      return true;
    } catch (cause) {
      await candidate?.dispose().catch(() => undefined);
      if (nextGeneration === generation) error = messageFor(cause);
      return false;
    } finally {
      if (nextGeneration === generation) {
        busy = false;
        preservingSetup = false;
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
           false,
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

  async function applyLive(step: ScenarioStep, current = session): Promise<SimulationState | null> {
    if (!current || current !== session) return null;
    error = "";
    try {
      const state = await current.apply($state.snapshot(step));
      if (current !== session) return null;
      simulationState = state;
      if (selectedWindowId && !state.windows.some(({ id }) => id === selectedWindowId))
        selectedWindowId = null;
      return state;
    } catch (cause) {
      if (current === session) {
        sessionMatchesCursor = false;
        error = messageFor(cause);
        try {
          const updated = await current.snapshot();
          if (current === session) simulationState = updated;
        } catch {
          // Keep the last usable state if the worker itself failed.
        }
      }
      return null;
    }
  }

  async function performSetup(stepsToRecord: readonly ScenarioStep[]) {
    if (running || (busy && !preservingSetup)) return;
    if (hasStepDrafts) {
      notice = "Apply your step changes before changing the desktop.";
      return;
    }
    const first = stepsToRecord[0];
    if (stepsToRecord.length === 1 && first && "event" in first && first.event.kind === "focus_changed" && simulationState.focusedWindow === first.event.windowId) {
      const id = first.event.windowId;
      const target = simulationState.windows.find((window) => window.id === id);
      const workspace = target?.workspace === undefined ? "1" : target.workspace;
      if (!target || simulationState.focusedWorkspace === workspace) return;
    }
    stopPlayback();
    if (!sessionMatchesCursor) {
        notice = "A failed step may have changed the desktop. Return to start or apply step changes before recording more actions.";
      return;
    }
    const expectedScenario = $state.snapshot(scenario);
    const next = insertScenarioSteps(expectedScenario, stepIndex, stepsToRecord);
    const current = session;
    const expectedGeneration = generation;
    for (const step of next.steps) {
      const state = await applyLive(step, current);
      if (!state || current !== session || expectedGeneration !== generation) return;
    }
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
  }

  function enqueueSetup(operation: () => Promise<void>): Promise<void> {
    const epoch = inputEpoch;
    pendingEdits += 1;
    const result = actionTail.then(async () => {
        try { if (epoch === inputEpoch) await operation(); }
      catch (cause) { error = messageFor(cause); }
      finally { pendingEdits -= 1; }
    });
    actionTail = result;
    return result;
  }

  function applySetup(step: ScenarioStep): Promise<void> {
    return enqueueSetup(() => performSetup([step]));
  }

  async function advance(): Promise<boolean> {
    if (!session || complete || busy) return false;
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
    let state: SimulationState | null = null;
    let submitted = false;
    const submit = async () => {
      if (abort.signal.aborted || expectedGeneration !== generation || current !== session) return;
      submitted = true;
      state = await applyLive(step, current);
    };
    try {
      const requested = "command" in step ? parseScenarioCommand(step.command) : null;
      const chord = requested && heroKeyboardChords.find((candidate) => JSON.stringify(parseScenarioCommand(keyboardCommand(candidate.command))) === JSON.stringify(requested));
      if (chord && presentation.animate !== false && presentation.showKeyboard !== false) {
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
    while (token === playbackToken && (await advance())) {
      if (complete) break;
      await delay(presentation.animate === false ? 0 : steps[stepIndex]?.duration ?? 1200, token);
    }
    if (token === playbackToken) running = false;
  }

  function returnToStart() {
    void replaceSession(
      scenario,
      "Returned to the starting layout. New actions will be recorded before the first step.",
      true,
    );
  }

  function rebase() {
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
      return await replaceSession(next, "Steps changed. Playback reset to the starting layout.", true);
    } catch (cause) {
      error = messageFor(cause);
      return false;
    }
  }

  async function applyImportedConfig(config: Config): Promise<boolean> {
    if (hasStepDrafts || running || busy || pendingEdits > 0) {
      notice = "Pause playback and apply step changes before loading config.";
      return false;
    }
    const next = parseScenario({ ...scenario, config });
    return replaceSession(next, "Local config loaded. Playback reset; click the desktop to use its hotkeys.");
  }

  function updatePresentation(nextPresentation: Presentation) {
    try {
      scenario = parseScenario({ ...scenario, presentation: nextPresentation });
      panelRevision += 1;
      documentText = JSON.stringify(scenario, null, 2);
    } catch (cause) {
      error = messageFor(cause);
    }
  }

  function updateSimulation(os: ScenarioOsRules | undefined) {
    if (hasStepDrafts || running || busy || pendingEdits > 0) {
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
    await applySetup({ command: `service ${action}` });
  }

  async function togglePause() {
    await applySetup({ command: simulationState.paused ? "resume" : "pause" });
  }

  async function addDisplay() {
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

  function selectWindow(id: string, displayId?: string) {
    selectedWindowId = id;
    selectedDisplayId = displayId ?? null;
    if (running || (busy && !preservingSetup)) return;
    void focusWindow(id);
  }

  function closeInspector() {
    const id = selectedWindowId;
    selectedWindowId = null;
    selectedDisplayId = null;
    const windowElement = [...document.querySelectorAll<HTMLElement>("[data-window-id]")].find((element) => element.dataset.windowId === id);
    windowElement?.querySelector<HTMLElement>(".window-titlebar")?.focus({ preventScroll: true });
  }

  async function changeWindow(id: string, frame: SimulationWindow["frame"]) {
    const window = simulationState.windows.find((candidate) => candidate.id === id);
    if (!window) return;
    await applySetup({ event: { kind: "window_changed", window: { ...physicalWindow(window), frame } } });
  }

  async function closeWindow(id: string) {
    await applySetup({ event: { kind: "window_removed", windowId: id } });
  }

  async function activate(appId: string, displayId?: string) {
    if (appId === "com.paneform.wm") {
      await service("start");
      return;
    }
    await enqueueSetup(async () => {
      const existing = simulationState.windows.find(({ bundleId }) => bundleId === appId);
      if (existing) {
        const title = existing.title ?? existing.id;
        await performSetup([{ event: { kind: "focus_changed", windowId: existing.id }, caption: `Focus ${title}.` }]);
        return;
      }
      const display = simulationState.topology.find(({ id }) => id === displayId) ?? simulationState.topology[0];
      if (!display) return;
      const workArea = display.workArea ?? display.frame;
      const allocated = nextPlayWindowId(scenario, simulationState.windows.map(({ id }) => id), openSequence);
      openSequence = allocated.sequence;
      const offset = ((openSequence - 1) % 6) * 36;
      const app = HERO_APPS.find(({ bundleId }) => bundleId === appId);
      const maxWidth = app && "maxWidth" in app ? app.maxWidth : undefined;
      const width = Math.max(1, Math.min(maxWidth ?? 900, workArea.width - 80));
      const height = Math.max(1, Math.min(620, workArea.height - 80));
      const added: SimulationWindow = { id: allocated.id, title: app?.title ?? "Window", bundleId: appId, frame: { x: workArea.x + Math.min(40 + offset, Math.max(0, workArea.width - width)), y: workArea.y + Math.min(40 + offset, Math.max(0, workArea.height - height)), width, height } };
      const window = maxWidth === undefined ? added : { ...added, constraints: { maxWidth } };
      const launchSteps: ScenarioStep[] = [];
      if (simulationState.wmRunning !== false && !simulationState.paused && display.workspace !== null && simulationState.focusedWorkspace !== display.workspace)
        launchSteps.push({ command: `workspace focus ${quoteCommandToken(display.workspace)}` });
      launchSteps.push({ event: { kind: "window_added", window: physicalWindow(window), focus: true }, caption: `Open ${window.title ?? "Window"}` });
      await performSetup(launchSteps);
    });
  }

  async function focusWorkspace(name: string, displayId?: string) {
    if (!simulationState.topology.some((display) => display.id === displayId) && displayId !== undefined) return;
    await applySetup({ command: `workspace focus ${quoteCommandToken(name)}` });
  }

  async function saveWindow(window: SimulationWindow) {
    await applySetup({ event: { kind: "window_changed", window: physicalWindow(window) } });
  }

  function loadDocument() {
    try {
      if (new TextEncoder().encode(documentText).byteLength > MAX_SCENARIO_BYTES)
        throw new Error("Scenario JSON must be 1 MiB or smaller.");
      const loaded = parseScenario(JSON.parse(documentText));
      const next = parseScenario({ ...loaded, steps: loaded.steps ?? [] });
      void replaceSession(next, undefined, false, true);
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
    if (document.hidden && running) stopPlayback("Playback paused while this tab is hidden.");
  }

  onNavigate(({ to }) => {
    if (to?.url.pathname === location.pathname) void loadHash(to.url.hash);
  });

  onMount(() => {
    const handleHash = () => void loadHash(location.hash);
    window.addEventListener("keydown", modifierTracker.keydown, true);
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
      stopPlayback();
      keyboard.stop();
      modifierTracker.reset();
      window.removeEventListener("keydown", modifierTracker.keydown, true);
      window.removeEventListener("keyup", modifierTracker.keyup, true);
      window.removeEventListener("blur", modifierTracker.reset);
      window.removeEventListener("pagehide", modifierTracker.reset);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("hashchange", handleHash);
      window.removeEventListener("popstate", handleHash);
      const current = session;
      session = null;
      void current?.dispose().catch(() => undefined);
    };
  });
</script>

<section class="player" aria-labelledby="play-heading" aria-busy={busy}>
  <header class="intro"><div><p class="eyebrow">Paneform playground</p><h1 id="play-heading">{title}</h1></div><p>{description}</p></header>
  <div class="showcase">
    {#key inputEpoch}<ScenarioStage
      state={simulationState}
      {presentation}
      controller={keyboard}
      interactive={!running && (!busy || preservingSetup)}
      selectable
      onactivate={(app, display) => void activate(app, display)}
      onselectwindow={selectWindow}
      onclosewindow={(id) => void closeWindow(id)}
      onmovewindow={(id, point) => { const window = simulationState.windows.find((item) => item.id === id); if (window) return changeWindow(id, { ...window.frame, ...point }); }}
      onresizewindow={(id, frame) => changeWindow(id, frame)}
      onfocusworkspace={(name, display) => void focusWorkspace(name, display)}
      onshortcut={handleShortcut}
    />{/key}
    <div class="caption" aria-live="polite"><span>{stepIndex < 0 ? "Start" : `${stepIndex + 1} / ${steps.length}`}</span><strong>{currentStep?.caption ?? "Starting layout"}</strong>{#if currentStep}<code>{"command" in currentStep ? currentStep.command : currentStep.event.kind}</code>{/if}</div>
  </div>

  {#if selectedWindow}
    <FloatingWindowPanel displayId={selectedDisplayId} refreshKey={inputEpoch + panelRevision} onclose={closeInspector}>
      <WindowInspector window={selectedWindow} editable={!busy && !running} onsave={saveWindow} onclose={closeInspector} />
    </FloatingWindowPanel>
  {/if}

  <div class="controls" aria-label="Playground controls">
    <button class="primary" type="button" disabled={(busy && !running) || complete || steps.length === 0 || hasStepDrafts || pendingEdits > 0} onclick={() => void play()}>{running ? "Pause playback" : "Play"}</button>
    <button type="button" disabled={busy || running || complete || steps.length === 0 || hasStepDrafts || pendingEdits > 0} onclick={() => void advance()}>Step</button>
      <button type="button" onclick={returnToStart}>Return to start</button>
    {#if stepIndex >= 0}<button type="button" onclick={rebase}>Use current layout as new start</button>{/if}
    <label class="window-picker" for="inspect-window">Window<select id="inspect-window" value={selectedWindowId ?? ""} onchange={(event) => { selectedWindowId = event.currentTarget.value || null; selectedDisplayId = null; }}><option value="">Inspect a window</option>{#each simulationState.windows as window (window.id)}<option value={window.id}>{window.title ?? window.id}</option>{/each}</select></label>
    <span class="status" aria-live="polite">{notice}</span>
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <LocalConfig onload={applyImportedConfig} disabled={busy || running || hasStepDrafts || pendingEdits > 0} />
  <p class="draft-notice">Click the desktop to use {scenario.config?.keybinds === undefined ? "the demo hotkeys" : "your configured hotkeys"}. Keyboard shortcuts are inactive while editing text or playing a scenario.</p>
  {#if keybindIssues.length}
    <details class="keybind-issues"><summary>{keybindIssues.length} hotkey{keybindIssues.length === 1 ? "" : "s"} unavailable in this browser</summary><ul>{#each keybindIssues as issue}<li><code>{issue.chord}</code>: {issue.reason}</li>{/each}</ul></details>
  {/if}

  <AdvancedControls
    {presentation}
    osRules={scenario.simulation?.os}
    {rememberedMacOsRules}
    state={simulationState}
    busy={busy || running || pendingEdits > 0}
    onpresentationchange={updatePresentation}
    onsimulationchange={updateSimulation}
    onstart={() => void service("start")}
    onstop={() => void service("stop")}
    onpause={() => void togglePause()}
    onadddisplay={() => void addDisplay()}
    onremovedisplay={(id) => void removeDisplay(id)}
  />

    <div class="authoring"><StepEditor {scenario} sessionKey={inputEpoch} disabled={busy || running || pendingEdits > 0} onchange={changeSteps} ondirtychange={(dirty) => (hasStepDrafts = dirty)} /></div>
  {#if hasStepDrafts}<p class="draft-notice">Finish building and apply your step changes before playback.</p>{/if}

  <details class="editor">
    <summary>JSON and sharing</summary>
    <p>The fragment never leaves this browser by itself. Compression is not privacy: window titles, configuration, and captions are visible to link recipients.</p>
    <label for="scenario-json">Scenario JSON</label><textarea id="scenario-json" bind:value={documentText} maxlength={maximumDocumentLength} spellcheck="false"></textarea>
    <div class="editor-actions"><button class="primary" type="button" disabled={busy} onclick={loadDocument}>Load scenario</button><button type="button" onclick={() => void copyJson()}>Copy JSON</button><button type="button" onclick={() => void shareLink()}>Copy share link</button><a href="/wm/play/scenario.schema.json">JSON Schema</a></div>
    {#if fallbackLink}<label for="share-link">Share link</label><input id="share-link" class="share-link" readonly value={fallbackLink} onclick={(event) => event.currentTarget.select()} />{/if}
  </details>
</section>

<style>
  .player { width: min(100% - 2 * var(--page-gutter), 88rem); margin-inline: auto; padding-block: 2rem; }
  .intro { display: grid; grid-template-columns: minmax(0, 1fr) minmax(18rem, 0.8fr); align-items: end; gap: 3rem; margin-bottom: 1.5rem; } .eyebrow { margin: 0 0 0.6rem; color: var(--rp-foam); font-size: var(--type-size-label); font-weight: 650; letter-spacing: var(--type-tracking-label); text-transform: uppercase; } h1 { margin: 0; font-size: clamp(2rem, 4vw, 3.5rem); line-height: 1; } .intro > p { margin: 0; color: var(--color-page-secondary); }
  .showcase { overflow: hidden; border: 1px solid var(--color-line-default); border-radius: 1rem; background: radial-gradient(circle at 50% 20%, color-mix(in srgb, var(--rp-iris) 10%, transparent), transparent 55%), var(--color-surface-base); }
  .caption { min-height: 4.5rem; display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 1rem; border-top: 1px solid var(--color-line-default); padding: 0.8rem 1.1rem; } .caption > span { color: var(--rp-foam); font-size: var(--type-size-label); text-transform: uppercase; } code { color: var(--rp-rose); font-size: 0.75rem; }
  .controls, .editor-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 0.6rem; } .controls { margin-block: 1rem; } .status { flex: 1; min-width: 14rem; color: var(--color-page-secondary); text-align: right; }
  button, .editor-actions a { min-height: var(--control-target); border: 1px solid var(--color-line-strong); border-radius: var(--radius-control); padding: 0.6rem 0.85rem; background: var(--color-surface-raised); color: inherit; font-weight: 650; cursor: pointer; } button.primary { border-color: var(--color-action-background); background: var(--color-action-background); color: var(--color-action-foreground); } button:disabled { cursor: not-allowed; opacity: 0.5; }
  .error { border-left: 3px solid var(--rp-love); padding: 0.7rem 1rem; color: var(--rp-love); } .authoring { max-width: 62rem; margin-top: 1.5rem; }
  .window-picker { display: flex; align-items: center; gap: 0.5rem; margin: 0; }
  .window-picker select { max-width: 14rem; min-height: var(--control-target); border: 1px solid var(--color-line-default); border-radius: var(--radius-control); padding: 0.5rem; background: var(--color-surface-raised); color: inherit; }
  .draft-notice { color: var(--color-page-secondary); font-size: 0.85rem; }
  .editor { margin-top: 1.5rem; border-top: 1px solid var(--color-line-default); padding-top: 1rem; } summary { width: fit-content; cursor: pointer; font-weight: 650; } .editor p, label { color: var(--color-page-secondary); font: 0.85rem/1.5 var(--type-family-system); } label { display: block; margin-block: 0.8rem 0.4rem; font-weight: 650; } textarea, .share-link { width: 100%; border: 1px solid var(--color-line-default); border-radius: var(--radius-control); padding: 0.8rem; background: var(--color-surface-base); color: inherit; font-family: var(--type-family-product); } textarea { min-height: 18rem; resize: vertical; } .editor-actions { margin-top: 0.6rem; } .editor-actions a { display: inline-grid; place-items: center; text-decoration: none; }
  :is(button, a, summary, textarea, input):focus-visible { outline: 2px solid var(--color-focus-ring); outline-offset: 2px; }
  @media (max-width: 52rem) { .intro { display: block; } .intro > p { margin-top: 1rem; } .authoring { grid-template-columns: 1fr; } .status { min-width: 100%; text-align: left; } }
  @media (max-width: 38rem) { .player { width: min(100% - 1rem, 88rem); } .caption { grid-template-columns: auto 1fr; } .caption code { grid-column: 1 / -1; overflow-wrap: anywhere; } }
</style>
