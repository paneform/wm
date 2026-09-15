<script lang="ts">
  import type { KeyboardKey } from "$lib/design/tokens.js";

  let {
    keyData,
    pressed = false,
    surface = "keyboard",
    ariaLabel,
  }: {
    keyData: KeyboardKey;
    pressed?: boolean;
    surface?: "keyboard" | "screen";
    ariaLabel?: string;
  } = $props();

  const modifierNames = new Map([
    ["control-left", "control"],
    ["option-left", "option"],
    ["command-left", "command"],
    ["command-right", "command"],
    ["option-right", "option"],
  ]);
</script>

<kbd
  class:pressed
  class:screen={surface === "screen"}
  class:split-legend={surface === "keyboard" && Boolean(keyData.alternateLegend)}
  class:number-key={keyData.code?.startsWith("Digit")}
  class="key"
  data-key={keyData.id}
  style:--screen-key-units={keyData.width}
  aria-label={ariaLabel}
>
  {#if keyData.id === "touch-id"}
    <span class="touch-id"></span>
  {:else}
    {#if keyData.alternateLegend}<span class="alternate">{keyData.alternateLegend}</span>{/if}
    <span class="primary-legend">{keyData.legend}</span>
    {#if keyData.id === "fn"}
      <svg class="fn-globe" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9"></circle>
        <path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"></path>
      </svg>
    {/if}
    {#if modifierNames.has(keyData.id)}
      <span class="modifier-name">{modifierNames.get(keyData.id)}</span>
    {/if}
  {/if}
</kbd>

<style>
  .key {
    position: relative;
    display: grid;
    width: 100%;
    height: calc(100% - var(--key-depth));
    place-content: center;
    margin: 0;
    border: 0;
    border-radius: var(--key-radius);
    padding: 0;
    background: var(--key-face-gradient);
    box-shadow: 0 var(--key-depth) 0 var(--color-key-depth);
    color: var(--color-key-label);
    font-family: var(--type-family-keyboard);
    font-size: var(--key-label);
    font-weight: 450;
    line-height: 1;
    transform: translateY(0);
    transition:
      transform var(--key-press-duration) var(--easing-mechanical),
      box-shadow var(--key-press-duration) var(--easing-mechanical);
  }

  .key.pressed {
    box-shadow: inset 0 var(--key-inset-depth) var(--key-inset-blur)
      color-mix(in srgb, var(--color-key-depth) 55%, transparent);
    transform: translateY(var(--key-depth));
  }

  .key[data-key="arrow-up"] { border-radius: var(--key-radius) var(--key-radius) 0 0; }
  .key[data-key="arrow-down"] { border-radius: 0 0 var(--key-radius) var(--key-radius); }

  .key:is([data-key="escape"], [data-key="tab"], [data-key="caps-lock"], [data-key="lshift"]) {
    place-content: end start;
    padding: var(--key-legend-padding);
  }

  .key:is([data-key="delete"], [data-key="return"], [data-key="rshift"]) {
    place-content: end;
    justify-content: end;
    padding: var(--key-legend-padding);
  }

  .key:is([data-key="lshift"], [data-key="rshift"]) {
    font-size: var(--key-shift-label);
    font-weight: var(--type-weight-regular);
  }

  .key:is(
    [data-key="lshift"],
    [data-key="rshift"],
    [data-key="tab"],
    [data-key="escape"],
    [data-key="delete"],
    [data-key="caps-lock"],
    [data-key="return"]
  ) {
    font-size: var(--key-named-label);
    font-weight: var(--type-weight-regular);
  }

  .key[data-key="fn"] .primary-legend { font-weight: 350; }

  .key:is([data-key="control-left"], [data-key="option-left"], [data-key="command-left"]) {
    place-content: start end;
    padding: var(--key-legend-padding);
  }

  .key:is([data-key="control-left"], [data-key="option-left"], [data-key="command-left"])
    .modifier-name {
    inset-inline: auto var(--key-legend-padding);
    transform: none;
  }

  .key:is([data-key="command-right"], [data-key="option-right"]) {
    place-content: start;
    justify-content: start;
    padding: var(--key-legend-padding);
  }

  .key:is([data-key="command-right"], [data-key="option-right"]) .modifier-name {
    inset-inline: var(--key-legend-padding) auto;
    transform: none;
  }

  .key[data-key="fn"] {
    place-content: start end;
    padding: var(--key-legend-padding);
  }

  .fn-globe {
    position: absolute;
    inset-block-end: var(--key-legend-padding);
    inset-inline-start: var(--key-legend-padding);
    width: 0.9em;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.3;
  }

  .alternate { font-size: var(--key-alt-label); }

  .key.split-legend {
    grid-template-rows: repeat(2, minmax(0, 1fr));
    place-content: stretch;
    place-items: center;
  }

  .key.split-legend .alternate { font-size: inherit; }

  .key.split-legend.number-key .alternate {
    font-size: 0.8em;
    font-weight: 300;
  }

  .modifier-name {
    position: absolute;
    inset-block-end: var(--key-legend-padding);
    inset-inline-start: 50%;
    font-size: var(--physical-modifier-label-size, 0.6em);
    font-weight: 300;
    transform: translateX(-50%);
  }

  .key:not(.screen) .modifier-name {
    inset-inline: var(--key-legend-padding);
    text-align: center;
    transform: none;
  }

  .touch-id {
    position: absolute;
    inset: 50% auto auto 50%;
    width: var(--touch-id-size);
    aspect-ratio: 1;
    border-radius: 50%;
    background: color-mix(in srgb, var(--color-key-depth) 18%, transparent);
    box-shadow: inset 0 var(--key-inset-depth) var(--key-inset-blur)
      color-mix(in srgb, var(--color-key-depth) 25%, transparent);
    transform: translate(-50%, -50%);
  }

  .key.screen {
    width: calc(2.15em * var(--screen-key-units));
    height: 2.15em;
    padding: 0.35em 0.5em;
    font-size: 1em;
    font-weight: var(--type-weight-regular);
    --key-depth: 0.16em;
    --key-label: 1em;
    --key-shift-label: 0.82em;
    --key-alt-label: 0.62em;
    --key-named-label: 0.52em;
    --key-legend-padding: 0.3em;
  }

  .key.screen .modifier-name { font-size: 0.52em; font-weight: var(--type-weight-regular); }

  @media (max-width: 45rem) {
    .key:not(.screen):is(
      [data-key="control-left"],
      [data-key="option-left"],
      [data-key="command-left"],
      [data-key="command-right"],
      [data-key="option-right"],
      [data-key="fn"]
    ) {
      place-content: center;
      justify-content: center;
      padding: 0;
    }

    .key:not(.screen) .modifier-name,
    .key:not(.screen)[data-key="fn"] .primary-legend { display: none; }
    .key:not(.screen) .fn-globe { position: static; }
  }
</style>
