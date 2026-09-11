<script lang="ts">
  import { onMount } from "svelte";

  import {
    keyboardKeys,
    tokens,
    type KeyboardChord,
    type KeyboardKey,
  } from "$lib/design/tokens.js";
  import type { KeyboardController, KeyboardSnapshot } from "./keyboard-controller.js";
  import KeyboardKeyFace from "./KeyboardKeyFace.svelte";
  import { sortShortcutKeys } from "./shortcut-key-order.js";

  let { controller }: { controller: KeyboardController } = $props();

  const keyById = new Map(keyboardKeys.map((key) => [key.id, key]));
  let keyboardState = $state<KeyboardSnapshot>();
  let completedChord = $state<KeyboardChord | null>(null);
  let visible = $state(false);
  let lastCompletedSequence = 0;
  let wasPressed = false;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  const pressedKeys = $derived(
    sortShortcutKeys(
      keyboardKeys.filter(({ id }) => keyboardState?.pressed.has(id)),
      keyboardKeys,
    ),
  );
  const displayKeys = $derived(
    pressedKeys.length
      ? pressedKeys
      : sortShortcutKeys(
          completedChord?.keys
            .map((id) => keyById.get(id))
            .filter((key): key is KeyboardKey => Boolean(key)) ?? [],
          keyboardKeys,
        ),
  );
  const displayChord = $derived(keyboardState?.activeChord ?? completedChord);

  function keyName(key: KeyboardKey): string {
    if (key.id === "lshift") return "left shift";
    if (key.id === "rshift") return "right shift";
    return key.legend || "space";
  }

  function chordLabel(chord: KeyboardChord): string {
    const keys = chord.keys
      .map((keyId) => keyById.get(keyId))
      .filter((key): key is KeyboardKey => Boolean(key));
    return `${chord.readout}; ${sortShortcutKeys(keys, keyboardKeys)
      .map((key) => keyName(key))
      .join(" + ")}`;
  }

  function linger(chord: KeyboardChord) {
    if (hideTimer) clearTimeout(hideTimer);
    completedChord = chord;
    visible = true;
    hideTimer = setTimeout(() => {
      if (!keyboardState?.pressed.size) visible = false;
      hideTimer = undefined;
    }, tokens.motion.commandReadout);
  }

  onMount(() => {
    const unsubscribe = controller.subscribe((next) => {
      keyboardState = next;
      if (next.pressed.size) {
        if (!wasPressed) {
          if (hideTimer) clearTimeout(hideTimer);
          hideTimer = undefined;
          completedChord = null;
        }
        visible = true;
      } else if (!hideTimer) {
        visible = false;
      }

      if (next.completedCommand && next.completedCommand.sequence > lastCompletedSequence) {
        lastCompletedSequence = next.completedCommand.sequence;
        linger(next.completedCommand.chord);
      }
      wasPressed = Boolean(next.pressed.size);
    });

    return () => {
      unsubscribe();
      if (hideTimer) clearTimeout(hideTimer);
    };
  });
</script>

<section
  class:visible
  class="shortcut-readout"
  aria-atomic="true"
  aria-live="polite"
  aria-hidden={!visible}
  aria-label={displayChord ? chordLabel(displayChord) : undefined}
>
  <div class="chord">
    {#each displayKeys as key, index (key.id)}
      <KeyboardKeyFace
        keyData={key}
        pressed={Boolean(keyboardState?.pressed.has(key.id))}
        surface="screen"
        ariaLabel={keyName(key)}
      />
      {#if index < displayKeys.length - 1}<span class="joiner">+</span>{/if}
    {/each}
  </div>
  {#if displayChord}<div class="command">
    <span class="command-mark" aria-hidden="true">↳</span>
    <span>{displayChord.readout}</span>
  </div>{/if}
</section>

<style>
  .shortcut-readout {
    position: absolute;
    z-index: var(--layer-shortcut-readout);
    inset: auto 0 calc(var(--dock-screen-bottom) + var(--dock-icon-size) + 1.15rem);
    width: max-content;
    max-width: calc(100% - 0.5rem);
    margin-inline: auto;
    padding: 0.65em 0.75em 0.7em;
    border: var(--stroke-hairline) solid var(--color-line-default);
    border-radius: var(--radius-control);
    background:
      linear-gradient(135deg, color-mix(in srgb, var(--rp-overlay) 90%, transparent), transparent),
      color-mix(in srgb, var(--color-screen-background) 84%, var(--color-surface-raised));
    box-shadow: 0 0.7em 1.2em color-mix(in srgb, var(--rp-base) 28%, transparent);
    color: var(--color-page-foreground);
    font-family: var(--type-family-product);
    font-size: clamp(0.42rem, 1.05vw, 0.72rem);
    line-height: 1;
    pointer-events: none;
    opacity: 0;
    visibility: hidden;
    transition:
      opacity 150ms var(--easing-standard),
      visibility 0s linear 150ms;
  }

  .shortcut-readout.visible {
    opacity: 1;
    visibility: visible;
    border-color: color-mix(in srgb, var(--color-window-focus) 72%, var(--color-line-default));
    background:
      linear-gradient(135deg, color-mix(in srgb, var(--rp-iris) 14%, transparent), transparent),
      color-mix(in srgb, var(--color-screen-background) 82%, var(--color-surface-raised));
    transition-duration: 100ms;
    transition-delay: 0s;
  }

  .chord {
    display: flex;
    align-items: center;
    gap: 0.28em;
    min-width: 0;
  }

  .joiner {
    color: var(--color-page-quiet);
    font-size: 0.85em;
    transform: translateY(0.08em);
  }

  .command {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 0.42em;
    margin-top: 0.72em;
    padding-top: 0.62em;
    border-top: var(--stroke-hairline) solid var(--color-line-default);
    color: var(--color-page-secondary);
    font-size: 0.86em;
    line-height: 1.2;
    overflow-wrap: anywhere;
  }

  .command-mark {
    color: var(--color-state-connected);
    font-size: 1.25em;
    line-height: 0.8;
  }
</style>
