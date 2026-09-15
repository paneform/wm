<script lang="ts">
  import {
    describeScenarioCommandTokens,
    parseScenario,
    type LayoutScenario,
    type ScenarioEvent,
    type ScenarioStep,
  } from "@paneform/layout-browser";
  import CommandBuilder from "./CommandBuilder.svelte";
  import { deriveCommandContext, type CommandContext } from "./pure-command-builder.js";
  import {
    beginReorderGesture,
    reorderItem,
    type ReorderGesture,
  } from "./pure-step-editor.js";

  type Draft = { step: ScenarioStep; eventText: string };
  type EventKind = ScenarioEvent["kind"];

  let {
    scenario,
    sessionKey = 0,
    disabled = false,
    onchange,
    ondirtychange,
  }: {
    scenario: LayoutScenario;
    sessionKey?: number;
    disabled?: boolean;
    onchange: (steps: readonly ScenarioStep[]) => boolean | Promise<boolean>;
    ondirtychange?: (dirty: boolean) => void;
  } = $props();

  let drafts = $state<Draft[]>([]);
  let observedSteps = "";
  let observedSessionKey: number | undefined;
  let error = $state("");
  let unsaved = $state(false);
  let page = $state(0);
  let activeCommand = $state<number | "new" | null>(null);
  let builderContext = $state<CommandContext | null>(null);
  let builderProblem = $state("");
  let draggedIndex = $state<number | null>(null);
  let grabbedIndex = $state<number | null>(null);
  let gesture: ReorderGesture<Draft> | null = null;

  const maximumEventLength = 1024 * 1024;
  const maximumCommandLength = 4_096;
  const stepsPerPage = 20;
  const pageCount = $derived(Math.max(1, Math.ceil(drafts.length / stepsPerPage)));
  const visibleDrafts = $derived(
    drafts.slice(page * stepsPerPage, (page + 1) * stepsPerPage).map((draft, offset) => ({
      draft,
      index: page * stepsPerPage + offset,
    })),
  );
  const builderContextKey = $derived.by(() => {
    if (activeCommand === null) return "";
    const before = activeCommand === "new" ? drafts.length : activeCommand;
    return JSON.stringify({
      config: scenario.config,
      state: scenario.state,
      prefix: drafts.slice(0, before).map(({ step, eventText }) => ({ step, eventText })),
    });
  });

  function makeDraft(step: ScenarioStep): Draft {
    const snapshot = $state.snapshot(step);
    return {
      step: structuredClone(snapshot),
      eventText: "event" in snapshot ? JSON.stringify(snapshot.event, null, 2) : "",
    };
  }

  $effect(() => {
    const incomingSteps = JSON.stringify(scenario.steps ?? []);
    if (incomingSteps !== observedSteps || sessionKey !== observedSessionKey) {
      discardGesture();
      observedSteps = incomingSteps;
      observedSessionKey = sessionKey;
      drafts = (scenario.steps ?? []).map(makeDraft);
      error = "";
      unsaved = false;
      page = 0;
      activeCommand = null;
      builderContext = null;
    }
  });

  $effect(() => {
    if (disabled) cancelGesture();
  });

  $effect(() => {
    if (page >= pageCount) page = pageCount - 1;
  });

  $effect(() => {
    if (builderContextKey === "" || activeCommand === null) return;
    refreshBuilderContext(activeCommand);
  });

  let reportedDirty: boolean | undefined;
  $effect(() => {
    const dirty = unsaved || activeCommand !== null;
    if (dirty !== reportedDirty) {
      reportedDirty = dirty;
      ondirtychange?.(dirty);
    }
  });

  function message(cause: unknown): string {
    try {
      const detail = cause instanceof Error ? cause.message : "The step is not valid.";
      return detail.slice(0, 2_000);
    } catch {
      return "The step is not valid.";
    }
  }

  function validatedSteps(nextDrafts: Draft[], includePresentation = true): readonly ScenarioStep[] {
    const steps = nextDrafts.map(({ step, eventText }, index): ScenarioStep => {
      if ("command" in step) {
        if (step.command.length > maximumCommandLength)
          throw new Error(`Step ${index + 1} command exceeds ${maximumCommandLength} characters.`);
        return step;
      }
      if (eventText.length > maximumEventLength)
        throw new Error(`Step ${index + 1} event JSON exceeds 1 MiB.`);
      return { ...step, event: JSON.parse(eventText) };
    });
    const input = includePresentation ? { ...scenario, steps } : { config: scenario.config, state: scenario.state, steps };
    return parseScenario(input).steps ?? [];
  }

  function setDrafts(nextDrafts: Draft[]) {
    drafts = nextDrafts;
    unsaved = true;
    try {
      validatedSteps(nextDrafts);
      error = "";
    } catch (cause) {
      error = message(cause);
    }
  }

  function refreshBuilderContext(index: number | "new") {
    const before = index === "new" ? drafts.length : index;
    try {
      const prefix = validatedSteps(drafts.slice(0, before), false);
      const next = deriveCommandContext(scenario, prefix);
      if (JSON.stringify(next) !== JSON.stringify(builderContext)) builderContext = next;
      builderProblem = "";
    } catch {
      builderContext = null;
      builderProblem = "Fix the invalid earlier event before building a command here.";
    }
  }

  function openCommand(index: number | "new") {
    activeCommand = index;
    refreshBuilderContext(index);
  }

  function closeCommand() {
    activeCommand = null;
    builderContext = null;
    builderProblem = "";
  }

  async function applySteps() {
    if (activeCommand !== null) return;
    try {
      const submitted = drafts;
      const steps = validatedSteps(submitted);
      error = "";
      const applied = await onchange(steps);
      if (!applied || submitted !== drafts || JSON.stringify(scenario.steps ?? []) !== JSON.stringify(steps)) return;
      observedSteps = JSON.stringify(steps);
      unsaved = false;
    } catch (cause) {
      error = message(cause);
    }
  }

  function replace(index: number, step: ScenarioStep, eventText = drafts[index]?.eventText ?? "") {
    const next = drafts.slice();
    next[index] = { step, eventText };
    setDrafts(next);
  }

  function updateCommand(index: number, command: string) {
    const current = drafts[index]?.step;
    if (!current || !("command" in current)) return;
    replace(index, { ...current, command });
    closeCommand();
  }

  function updatePresentation(index: number, field: "caption" | "duration", value: string) {
    const current = drafts[index]?.step;
    if (!current) return;
    const { [field]: _removed, ...rest } = current;
    const next: ScenarioStep =
      value === ""
        ? rest
        : field === "duration"
          ? { ...rest, duration: Number(value) }
          : { ...rest, caption: value };
    replace(index, next);
  }

  function updateEventText(index: number, eventText: string) {
    const current = drafts[index]?.step;
    if (!current || !("event" in current)) return;
    const next = drafts.slice();
    next[index] = { step: current, eventText };
    setDrafts(next);
  }

  function eventFor(kind: EventKind): ScenarioEvent {
    const window = scenario.state.windows[0];
    switch (kind) {
      case "focus_changed": return { kind, windowId: window?.id ?? null };
      case "window_added": return { kind, window: { id: nextWindowId(), frame: { x: 80, y: 80, width: 640, height: 480 } } };
      case "window_changed": return { kind, window: window ? { id: window.id, frame: window.frame } : { id: "window", frame: { x: 80, y: 80, width: 640, height: 480 } } };
      case "window_removed": return { kind, windowId: window?.id ?? "window" };
      case "topology_changed": return { kind, topology: scenario.state.topology.map(({ workspace: _workspace, ...display }) => display) };
      case "space_changed": return { kind };
      case "sleep": return { kind };
      case "wake": return { kind };
    }
  }

  function nextWindowId(): string {
    const ids = new Set(scenario.state.windows.map(({ id }) => id));
    for (const { step } of drafts)
      if ("event" in step && step.event.kind === "window_added") ids.add(step.event.window.id);
    let suffix = 1;
    while (ids.has(suffix === 1 ? "new-window" : `new-window-${suffix}`)) suffix += 1;
    return suffix === 1 ? "new-window" : `new-window-${suffix}`;
  }

  function changeEventKind(index: number, kind: EventKind) {
    const current = drafts[index]?.step;
    if (!current || !("event" in current)) return;
    const event = eventFor(kind);
    replace(index, { ...current, event }, JSON.stringify(event, null, 2));
  }

  function selectEventKind(index: number, value: string) {
    switch (value) {
      case "focus_changed":
      case "window_added":
      case "window_changed":
      case "window_removed":
      case "topology_changed":
      case "sleep":
      case "wake":
      case "space_changed":
        changeEventKind(index, value);
    }
  }

  function move(index: number, target: number) {
    if (disabled || target < 0 || target >= drafts.length || target === index) return;
    closeCommand();
    setDrafts(reorderItem(drafts, index, target));
    page = Math.floor(target / stepsPerPage);
  }

  function beginGesture(index: number) {
    gesture = beginReorderGesture(drafts, index, unsaved, page, error);
  }

  function discardGesture() {
    gesture = null;
    draggedIndex = null;
    grabbedIndex = null;
  }

  function commitGesture() {
    discardGesture();
  }

  function cancelGesture() {
    if (!gesture) return;
    drafts = [...gesture.items];
    unsaved = gesture.unsaved;
    page = gesture.page;
    error = gesture.error;
    discardGesture();
  }

  function handleDragKeydown(event: KeyboardEvent, index: number) {
    if (disabled) return;
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      if (grabbedIndex === null) {
        beginGesture(index);
        grabbedIndex = index;
      } else {
        commitGesture();
      }
    } else if (grabbedIndex !== null && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      const target = grabbedIndex + (event.key === "ArrowUp" ? -1 : 1);
      if (target < 0 || target >= drafts.length) return;
      move(grabbedIndex, target);
      grabbedIndex = target;
      queueMicrotask(() => document.querySelector<HTMLElement>(`[data-drag-index="${target}"]`)?.focus());
    } else if (grabbedIndex !== null && event.key === "Escape") {
      event.preventDefault();
      cancelGesture();
    }
  }

  function pointerDrag(event: PointerEvent) {
    if (draggedIndex === null || event.buttons === 0) return;
    event.preventDefault();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-step-index]");
    const targetIndex = Number(target?.dataset.stepIndex);
    if (!Number.isInteger(targetIndex) || targetIndex === draggedIndex) return;
    move(draggedIndex, targetIndex);
    draggedIndex = targetIndex;
  }

  function remove(index: number) {
    closeCommand();
    setDrafts(drafts.filter((_, itemIndex) => itemIndex !== index));
  }

  function appendCommand() {
    openCommand("new");
  }

  function insertCommand(command: string) {
    setDrafts([...drafts, makeDraft({ command })]);
    page = Math.floor(drafts.length / stepsPerPage);
    closeCommand();
  }

  function appendEvent() {
    const event = eventFor("focus_changed");
    setDrafts([...drafts, makeDraft({ event })]);
    page = Math.floor(drafts.length / stepsPerPage);
  }
</script>

<section class="step-editor" aria-labelledby="step-editor-title">
  <header><div><small>Sequence</small><h2 id="step-editor-title">Scenario steps</h2></div><span>{drafts.length} steps</span></header>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if pageCount > 1}
    <nav class="pagination" aria-label="Step pages">
      <button type="button" disabled={page === 0} onclick={() => { page -= 1; }}>Previous</button>
      <label>Page<select value={page} onchange={(event) => { page = Number(event.currentTarget.value); }}>
        {#each Array.from({ length: pageCount }) as _, pageIndex}<option value={pageIndex}>{pageIndex + 1}</option>{/each}
      </select> of {pageCount}</label>
      <button type="button" disabled={page === pageCount - 1} onclick={() => { page += 1; }}>Next</button>
    </nav>
  {/if}
  <ol start={page * stepsPerPage + 1}>
    {#each visibleDrafts as { draft, index }}
      <li data-step-index={index}>
        <div class="step-heading">
          <button
            type="button"
            class="drag-handle"
            data-drag-index={index}
            disabled={disabled}
            aria-label={`Reorder step ${index + 1}`}
            aria-pressed={grabbedIndex === index}
            title="Drag to reorder. Press Space to pick up, arrow keys to move, and Escape to cancel."
            onpointerdown={(event) => {
              if (disabled || !event.isPrimary || event.button !== 0) return;
              beginGesture(index);
              draggedIndex = index;
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onpointermove={pointerDrag}
            onpointerup={(event) => {
              if (draggedIndex === null) return;
              commitGesture();
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onpointercancel={cancelGesture}
            onlostpointercapture={cancelGesture}
            onkeydown={(event) => handleDragKeydown(event, index)}><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="5" cy="3" r="1.25"/><circle cx="11" cy="3" r="1.25"/><circle cx="5" cy="8" r="1.25"/><circle cx="11" cy="8" r="1.25"/><circle cx="5" cy="13" r="1.25"/><circle cx="11" cy="13" r="1.25"/></svg></button
          >
          <span class="step-number">{index + 1}</span>
          <label class="step-title"><span class="visually-hidden">Step {index + 1} title</span><input type="text" disabled={disabled} maxlength="2000" placeholder="Untitled step" value={draft.step.caption ?? ""} oninput={(event) => updatePresentation(index, "caption", event.currentTarget.value)} /></label>
          <div class="step-actions">
            <button class="remove" type="button" disabled={disabled} onclick={() => remove(index)} aria-label={`Remove step ${index + 1}`} title={`Remove step ${index + 1}`}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h10M6 2h4l1 2H5l1-2Zm-1 4 .5 8h5L11 6M7 7v5m2-5v5"/></svg></button>
          </div>
        </div>
        {#if "command" in draft.step}
          <div class="command-line"><span>Command</span><button class="command" type="button" disabled={disabled} onclick={() => openCommand(index)} aria-label={`Edit command for step ${index + 1}`} aria-describedby={`command-description-${index}`}>
            <code>{#each describeScenarioCommandTokens(draft.step.command) as token}<span title={token.description}>{token.value}</span>{/each}</code>
          </button><span class="visually-hidden" id={`command-description-${index}`}>{describeScenarioCommandTokens(draft.step.command).map(({ description }) => description).join(" ")}</span></div>
          {#if activeCommand === index}
            {#if builderContext}<CommandBuilder context={builderContext} initialCommand={draft.step.command} {disabled} oncommit={(command) => updateCommand(index, command)} oncancel={closeCommand} />{:else}<p class="builder-problem">{builderProblem}</p>{/if}
          {/if}
        {:else}
          <label>Event kind<select disabled={disabled} value={draft.step.event.kind} onchange={(event) => selectEventKind(index, event.currentTarget.value)}>
            {#each ["focus_changed", "window_added", "window_changed", "window_removed", "topology_changed", "sleep", "wake", "space_changed"] as kind}<option value={kind}>{kind}</option>{/each}
          </select></label>
          <label>Event JSON<textarea disabled={disabled} maxlength={maximumEventLength} spellcheck="false" value={draft.eventText} oninput={(event) => updateEventText(index, event.currentTarget.value)}></textarea></label>
        {/if}
        <div class="presentation">
          <label>Duration (ms)<input type="number" disabled={disabled} min="0" max="60000" value={draft.step.duration ?? ""} oninput={(event) => updatePresentation(index, "duration", event.currentTarget.value)} /></label>
        </div>
      </li>
    {/each}
  </ol>
  {#if activeCommand === "new"}
    <div class="new-command"><strong>New command</strong>{#if builderContext}<CommandBuilder context={builderContext} {disabled} oncommit={insertCommand} oncancel={closeCommand} />{:else}<p class="builder-problem">{builderProblem}</p><button type="button" onclick={closeCommand}>Cancel</button>{/if}</div>
  {/if}
  <div class="footer">
    <div class="append"><button type="button" disabled={disabled} onclick={appendCommand}>Add command</button><button type="button" disabled={disabled} onclick={appendEvent}>Add event</button></div>
    <div class="commit"><span aria-live="polite">{activeCommand !== null ? "Insert or cancel the command first" : unsaved ? "Unsaved step changes" : "Steps are up to date"}</span><button class="primary" type="button" disabled={disabled || !unsaved || activeCommand !== null} onclick={() => void applySteps()}>Apply steps</button></div>
  </div>
</section>

<style>
  .step-editor { color: var(--color-page-foreground); } header, .step-heading, .footer, .append, .commit, .pagination { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  h2 { margin: 0.15rem 0 0; font-size: 1.25rem; } small, header > span, label { color: var(--color-page-secondary); font: 0.8rem/1.4 var(--type-family-system); }
  ol { display: grid; gap: 0.75rem; margin: 1rem 0; padding: 0; list-style: none; } li { border: 1px solid var(--color-line-default); border-radius: 0.75rem; padding: 0.85rem; background: var(--color-surface-raised); }
  .pagination { justify-content: flex-end; margin-top: 1rem; } .pagination label { display: flex; align-items: center; gap: 0.4rem; margin: 0; } .pagination select { width: auto; }
  .step-heading { justify-content: start; } .step-number { flex: 0 0 1.5rem; color: var(--rp-foam); font-weight: 700; text-align: center; } .step-title { flex: 1; margin: 0; } .step-title input { border-color: transparent; padding-inline: 0.35rem; background: transparent; font-size: 1rem; font-weight: 650; } .step-title input:hover { border-color: var(--color-line-default); background: var(--color-surface-base); } .step-actions, .append { display: flex; gap: 0.4rem; }
  label { display: grid; gap: 0.3rem; margin-top: 0.7rem; } input, select, textarea { width: 100%; min-width: 0; border: 1px solid var(--color-line-default); border-radius: var(--radius-control); padding: 0.6rem; background: var(--color-surface-base); color: var(--color-page-foreground); font: 0.8rem/1.4 var(--type-family-product); }
  textarea { min-height: 8rem; resize: vertical; } .presentation { display: grid; grid-template-columns: 1fr minmax(8rem, 0.25fr); gap: 0.7rem; }
  .command-line { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 0.65rem; margin-top: 0.7rem; color: var(--color-page-secondary); font-size: 0.8rem; } .command { min-width: 0; text-align: left; } .command-line .command code { display: flex; flex-wrap: wrap; gap: 0.35rem; overflow-wrap: anywhere; color: var(--color-page-foreground); } .new-command { margin: 1rem 0; border: 1px dashed var(--color-line-strong); border-radius: 0.75rem; padding: 0.85rem; } .builder-problem { color: var(--color-page-secondary); }
  button { min-height: var(--control-target); border: 1px solid var(--color-line-strong); border-radius: var(--radius-control); padding: 0.5rem 0.7rem; background: var(--color-surface-raised); color: inherit; cursor: pointer; }
  button.primary { border-color: var(--color-action-background); background: var(--color-action-background); color: var(--color-action-foreground); }
  .drag-handle { flex: 0 0 var(--control-target); min-width: var(--control-target); padding: 0.55rem; cursor: grab; touch-action: none; } .drag-handle:active, .drag-handle[aria-pressed="true"] { cursor: grabbing; color: var(--rp-foam); } .drag-handle svg { display: block; width: 1rem; height: 1rem; fill: currentColor; } .remove { min-width: var(--control-target); color: var(--rp-love); } .remove svg { display: block; width: 1rem; height: 1rem; margin: auto; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; }
  .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid var(--color-focus-ring); outline-offset: 2px; } button:disabled { cursor: not-allowed; opacity: 0.55; }
  .error { border-left: 3px solid var(--rp-love); padding: 0.65rem; color: var(--rp-love); } .commit span { color: var(--color-page-secondary); font-size: 0.8rem; }
  @media (max-width: 36rem) { .step-heading { gap: 0.45rem; } .step-number { flex-basis: 1rem; } .footer { align-items: start; flex-direction: column; } .presentation, .command-line { grid-template-columns: 1fr; } }
</style>
