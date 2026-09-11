<script lang="ts">
  import { onMount } from "svelte";

  import { keyboardKeys, tokens } from "$lib/design/tokens.js";
  import type { KeyboardController, KeyboardSnapshot } from "./keyboard-controller.js";
  import KeyboardKeyFace from "./KeyboardKeyFace.svelte";

  let { controller }: { controller: KeyboardController } = $props();
  let state = $state<KeyboardSnapshot>();

  const geometry = tokens.keyboard;
  const percent = (value: number, total: number) => `${(value / total) * 100}%`;
  const keyStyle = (key: (typeof keyboardKeys)[number]) =>
    [
      `--key-x:${percent(key.x, geometry.bedWidth)}`,
      `--key-y:${percent(key.y, geometry.bedHeight)}`,
      `--key-width:${percent(key.width, geometry.bedWidth)}`,
      `--key-height:${percent(key.height, geometry.bedHeight)}`,
    ].join(";");
  onMount(() => controller.subscribe((next) => (state = next)));
</script>

<div
  class="keyboard"
  style:--touch-id-size={`${geometry.touchIdSize * 100}%`}
  style:--key-label={`${geometry.labelSize}em`}
  style:--key-shift-label={`${geometry.shiftLabelSize}em`}
  style:--key-alt-label={`${geometry.alternateLabelSize}em`}
  style:--key-named-label={`${geometry.labelSize * 0.72}em`}
  style:--key-press-duration={`${tokens.motion.press}ms`}
  aria-hidden="true"
>
  {#each keyboardKeys as key (key.id)}
    <div
      class:arrow-up={key.id === "arrow-up"}
      class:arrow-down={key.id === "arrow-down"}
      class="key-slot"
      style={keyStyle(key)}
    >
      <KeyboardKeyFace keyData={key} pressed={Boolean(state?.pressed.has(key.id))} />
    </div>
  {/each}
</div>

<style>
  .keyboard {
    position: relative;
    width: 100%;
    height: 100%;
    transform-style: preserve-3d;
  }

  .key-slot {
    position: absolute;
    inset-block-start: var(--key-y);
    inset-inline-start: var(--key-x);
    width: var(--key-width);
    height: var(--key-height);
    overflow: hidden;
    border-radius: var(--key-radius);
  }

  .key-slot.arrow-up { border-radius: var(--key-radius) var(--key-radius) 0 0; }
  .key-slot.arrow-down { border-radius: 0 0 var(--key-radius) var(--key-radius); }

</style>
