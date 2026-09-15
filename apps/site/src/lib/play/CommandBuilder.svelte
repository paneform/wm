<script lang="ts">
  import { tick } from "svelte";
  import { quoteCommandToken } from "@paneform/layout";
  import { describeScenarioCommandTokens, scenarioCommandPaths } from "@paneform/layout-browser";
  import {
    acceptCommandChoice,
    acceptTypedCommandToken,
    commandChoices,
    commandSlotHint,
    commandStateFromText,
    completedCommand,
    emptyCommandState,
    reopenCommandToken,
    sanitizeCommandState,
    type CommandBuilderState,
    type CommandChoice,
    type CommandContext,
  } from "./pure-command-builder.js";

  let {
    context,
    initialCommand,
    disabled = false,
    oncommit,
    oncancel,
  }: {
    context: CommandContext;
    initialCommand?: string;
    disabled?: boolean;
    oncommit: (command: string) => void;
    oncancel?: () => void;
  } = $props();

  const id = $props.id();
  const listId = `command-builder-${id}`;
  let input = $state<HTMLInputElement>();
  let root = $state<HTMLElement>();
  let tokenHeight = $state(44);
  let actionHeight = $state(44);
  let upwards = $state(false);
  let builderState: CommandBuilderState = $state(emptyCommandState());
  let highlighted = $state(0);
  let open = $state(true);
  let initialized = false;
  const choices = $derived(commandChoices(builderState, context));
  const complete = $derived(completedCommand(builderState));
  const hint = $derived(commandSlotHint(builderState));
  const tokenHelp = $derived(describeScenarioCommandTokens(builderState.accepted.map(({ value }) => quoteCommandToken(value)).join(" ")));

  function choiceHelp(choice: CommandChoice): string {
    const path = choice.paths[0];
    return path === undefined ? choice.label : scenarioCommandPaths[path]?.tokens[builderState.accepted.length]?.description ?? choice.label;
  }

  $effect(() => {
    if (!initialized) {
      initialized = true;
      if (initialCommand) builderState = commandStateFromText(initialCommand, context) ?? emptyCommandState();
      queueMicrotask(() => input?.focus());
    }
  });

  $effect(() => {
    const clean = sanitizeCommandState(builderState, context);
    if (clean !== builderState) builderState = clean;
  });

  $effect(() => {
    if (highlighted >= choices.length) highlighted = Math.max(0, choices.length - 1);
  });

  $effect(() => {
    const active = choices[highlighted] && open ? `${listId}-${highlighted}` : null;
    if (active) void tick().then(() => document.getElementById(active)?.scrollIntoView({ block: "nearest" }));
  });

  $effect(() => {
    const menuSpace = Math.min(264, choices.length * 40 + 8) + Math.min(16, tokenHeight + actionHeight);
    if (open) void tick().then(() => {
      if (!root?.isConnected) return;
      const bounds = root.getBoundingClientRect();
      const visual = window.visualViewport;
      const top = visual?.offsetTop ?? 0;
      const bottom = top + (visual?.height ?? window.innerHeight);
      upwards = bottom - bounds.bottom < menuSpace && bounds.top - top > menuSpace;
    });
  });

  function choose(choice: CommandChoice): CommandBuilderState {
    builderState = acceptCommandChoice(builderState, choice);
    highlighted = 0;
    open = true;
    return builderState;
  }

  function commitIfComplete(next = builderState): boolean {
    const command = completedCommand(next);
    if (!command) return false;
    oncommit(command);
    return true;
  }

  function acceptCurrent(): CommandBuilderState | null {
    const choice = choices[highlighted];
    if (choice) return choose(choice);
    const next = acceptTypedCommandToken(builderState, context);
    if (!next) return null;
    builderState = next;
    highlighted = 0;
    return next;
  }

  function keydown(event: KeyboardEvent) {
    if (event.isComposing || disabled) return;
    if ((event.key === " " || event.key === "Enter") && event.repeat) {
      event.preventDefault();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (choices.length === 0) return;
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      highlighted = (highlighted + offset + choices.length) % choices.length;
      open = true;
    } else if (
      event.key === " " &&
      choices[highlighted] &&
      !/^(['"])(?!.*\1$)/u.test(builderState.query)
    ) {
      event.preventDefault();
      choose(choices[highlighted]!);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (complete) commitIfComplete();
      else {
        const next = acceptCurrent();
        if (next) commitIfComplete(next);
      }
    } else if (event.key === "Backspace" && builderState.query === "" && builderState.accepted.length > 0) {
      event.preventDefault();
      builderState = reopenCommandToken(builderState);
      open = true;
    } else if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        open = false;
      } else oncancel?.();
    }
  }

  function inputChanged(value: string) {
    if (/\s/u.test(value.trim())) {
      const pasted = commandStateFromText(value, context);
      if (pasted) {
        builderState = pasted;
        return;
      }
    }
    builderState = { ...builderState, query: value };
    highlighted = 0;
    open = true;
  }
</script>

<div class="builder" bind:this={root}>
  <div class="actions" bind:clientHeight={actionHeight}>
    <button type="button" disabled={disabled} onclick={() => { builderState = emptyCommandState(); open = true; queueMicrotask(() => input?.focus()); }}>Clear</button>
    <button type="button" disabled={disabled || complete === null} onclick={() => commitIfComplete()}>Insert</button>
    {#if oncancel}<button type="button" onclick={oncancel}>Cancel</button>{/if}
  </div>
  <div class="tokens" bind:clientHeight={tokenHeight}>
    {#each builderState.accepted as token, index}
      <button
        type="button"
        class="chip"
        disabled={disabled}
        title={tokenHelp[index]?.description ?? token.label}
        onclick={(event) => {
          event.stopPropagation();
          builderState = reopenCommandToken(builderState, index);
          input?.focus();
        }}>{token.value}</button
      >
    {/each}
    <input
      bind:this={input}
      role="combobox"
      aria-label="Next command token"
      aria-autocomplete="list"
      aria-controls={listId}
      aria-expanded={open && choices.length > 0}
      aria-activedescendant={open && choices[highlighted] ? `${listId}-${highlighted}` : undefined}
      autocomplete="off"
      spellcheck="false"
      maxlength="4096"
      placeholder={hint}
      {disabled}
      value={builderState.query}
      oninput={(event) => inputChanged(event.currentTarget.value)}
      onkeydown={keydown}
      onfocus={() => (open = true)}
    />
  </div>
  {#if open && choices.length > 0}
    <div class="choices" id={listId} role="listbox" style:top={upwards ? "auto" : `${actionHeight + tokenHeight + 16}px`} style:bottom={upwards ? "calc(100% + 8px)" : "auto"}>
      {#each choices as choice, index}
        <button
          type="button"
          id={`${listId}-${index}`}
          role="option"
          tabindex="-1"
          {disabled}
          aria-selected={index === highlighted}
           class:highlighted={index === highlighted}
           title={choiceHelp(choice)}
          onmousedown={(event) => event.preventDefault()}
          onclick={() => {
            choose(choice);
            input?.focus();
          }}><span>{choice.value}</span>{#if choice.label !== choice.value}<small>{choice.label}</small>{/if}</button
        >
      {/each}
    </div>
  {:else if open}
    <p class="hint">{hint}</p>
  {/if}
</div>

<style>
  .builder { position: relative; display: grid; gap: 0.45rem; margin-top: 0.7rem; }
  .tokens { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem; min-height: var(--control-target); border: 1px solid var(--color-line-default); border-radius: var(--radius-control); padding: 0.35rem; background: var(--color-surface-base); }
  .tokens:focus-within { outline: 2px solid var(--color-focus-ring); outline-offset: 2px; }
  input { flex: 1 1 8rem; min-width: 6rem; border: 0; padding: 0.25rem; background: transparent; color: var(--color-page-foreground); font: 0.8rem/1.4 var(--type-family-product); outline: 0; }
  button { min-height: var(--control-target); border: 1px solid var(--color-line-strong); border-radius: var(--radius-control); padding: 0.45rem 0.65rem; background: var(--color-surface-raised); color: inherit; cursor: pointer; }
  .chip { min-height: 1.8rem; padding: 0.2rem 0.45rem; color: var(--rp-foam); font: 0.78rem/1.2 var(--type-family-product); }
  .choices { position: absolute; z-index: 5; top: calc(var(--control-target) + 0.45rem); display: grid; width: 100%; max-height: 16rem; overflow: auto; border: 1px solid var(--color-line-strong); border-radius: var(--radius-control); padding: 0.25rem; background: var(--color-surface-raised); box-shadow: 0 0.7rem 1.8rem rgb(0 0 0 / 0.24); }
  .choices button { display: flex; justify-content: space-between; gap: 1rem; min-height: 2.25rem; border-color: transparent; text-align: left; }
  .choices button.highlighted { border-color: var(--color-focus-ring); background: var(--color-surface-base); }
  .choices small { color: var(--color-page-secondary); }
  .hint { margin: 0; color: var(--color-page-secondary); font-size: 0.78rem; }
  .actions { display: flex; justify-content: flex-end; gap: 0.4rem; }
  button:disabled { cursor: not-allowed; opacity: 0.55; }
</style>
