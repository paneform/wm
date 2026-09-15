<script lang="ts">
  import { onMount } from "svelte";

  import { keyboardKeys, tokens } from "$lib/design/tokens.js";
  import type { KeyboardController, KeyboardSnapshot } from "./keyboard-controller.js";
  import KeyboardKeyFace from "./KeyboardKeyFace.svelte";

  let { controller }: { controller: KeyboardController } = $props();
  let state = $state<KeyboardSnapshot>();
  // oxlint-disable-next-line no-unassigned-vars -- Svelte assigns this through bind:this.
  let keyboardElement: HTMLDivElement | undefined;

  const geometry = tokens.keyboard;
  const percent = (value: number, total: number) => `${(value / total) * 100}%`;
  const keyStyle = (key: (typeof keyboardKeys)[number]) =>
    [
      `--key-x:${percent(key.x, geometry.bedWidth)}`,
      `--key-y:${percent(key.y, geometry.bedHeight)}`,
      `--key-width:${percent(key.width, geometry.bedWidth)}`,
      `--key-height:${percent(key.height, geometry.bedHeight)}`,
    ].join(";");
  onMount(() => {
    const unsubscribe = controller.subscribe((next) => (state = next));
    const keyboard = keyboardElement;
    if (!keyboard) return unsubscribe;

    const modifierLabels = Array.from(keyboard.querySelectorAll<HTMLElement>(".modifier-name"));
    const context = document.createElement("canvas").getContext("2d");
    const referenceSize = 100;
    let animationFrame = 0;
    let active = true;
    let fontsReady = false;

    const measure = () => {
      animationFrame = 0;
      const fittedSizes = modifierLabels.flatMap((label) => {
        const key = label.closest<HTMLElement>(".key");
        if (!key || getComputedStyle(label).display === "none" || !context) return [];

        const keyStyle = getComputedStyle(key);
        const labelStyle = getComputedStyle(label);
        const availableWidth = key.clientWidth - parseFloat(keyStyle.paddingLeft) - parseFloat(keyStyle.paddingRight);
        context.font = `${labelStyle.fontStyle} ${labelStyle.fontWeight} ${referenceSize}px ${labelStyle.fontFamily}`;
        const letterSpacing = labelStyle.letterSpacing === "normal" ? 0 : parseFloat(labelStyle.letterSpacing);
        const textWidth =
          context.measureText(label.textContent ?? "").width +
          letterSpacing * Math.max(0, (label.textContent?.length ?? 0) - 1);
        return textWidth > 0 ? [(availableWidth * referenceSize) / textWidth] : [];
      });

      if (fittedSizes.length > 0) keyboard.style.setProperty("--physical-modifier-label-size", `${Math.min(...fittedSizes)}px`);
      else keyboard.style.removeProperty("--physical-modifier-label-size");
    };
    const scheduleMeasure = () => {
      if (!active || !fontsReady) return;
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(keyboard);
    for (const label of modifierLabels) {
      const key = label.closest(".key");
      if (key) observer.observe(key);
    }
    void document.fonts.ready.then(() => {
      fontsReady = true;
      scheduleMeasure();
    });

    return () => {
      active = false;
      unsubscribe();
      observer.disconnect();
      cancelAnimationFrame(animationFrame);
    };
  });
</script>

<div
  bind:this={keyboardElement}
  class="keyboard"
  style:--touch-id-size={`${geometry.touchIdSize * 100}%`}
  style:--key-label={`${geometry.labelSize}em`}
  style:--key-shift-label={`${geometry.shiftLabelSize}em`}
  style:--key-alt-label={`${geometry.alternateLabelSize}em`}
  style:--key-named-label={`var(--physical-modifier-label-size, ${geometry.labelSize * 0.6}em)`}
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
