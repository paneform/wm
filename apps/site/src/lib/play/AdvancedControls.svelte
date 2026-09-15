<script lang="ts">
  import type { Presentation, SimulationState } from "@paneform/layout-browser";

  let {
    presentation,
    state,
    busy = false,
    onpresentationchange,
    onstart,
    onstop,
    onpause,
    onadddisplay,
    onremovedisplay,
  }: {
    presentation: Presentation;
    state: SimulationState;
    busy?: boolean;
    onpresentationchange: (presentation: Presentation) => void;
    onstart: () => void;
    onstop: () => void;
    onpause: () => void;
    onadddisplay: () => void;
    onremovedisplay: (id: string) => void;
  } = $props();

  function update<K extends keyof Presentation>(key: K, value: Presentation[K]) {
    onpresentationchange({ ...presentation, [key]: value });
  }

  function deviceFor(id: string): "laptop" | "display" {
    return presentation.devices?.[id] ?? presentation.device ?? "laptop";
  }

  function updateDevice(id: string, device: "laptop" | "display") {
    update("devices", { ...presentation.devices, [id]: device });
  }
</script>

<details class="advanced">
  <summary>Advanced controls</summary>
  <div class="content">
    <fieldset>
      <legend>Window manager</legend>
      <p class="state">{state.wmRunning === false ? "Stopped" : state.paused ? "Paused" : "Running"}</p>
      <div class="actions">
        {#if state.wmRunning === false}<button type="button" disabled={busy} onclick={onstart}>Start</button>{:else}<button type="button" disabled={busy} onclick={onstop}>Stop</button><button type="button" disabled={busy} onclick={onpause}>{state.paused ? "Resume" : "Pause"}</button>{/if}
      </div>
    </fieldset>
    <fieldset>
      <legend>Presentation</legend>
      <div class="checks">
        {#each [["showKeyboard", "Laptop keyboard"], ["showDock", "Dock"], ["showTopBar", "Top bar"], ["allowMove", "Move windows"], ["allowResize", "Resize windows"], ["animate", "Animate"]] as item}
          {@const key = item[0] as "showKeyboard" | "showDock" | "showTopBar" | "allowMove" | "allowResize" | "animate"}
          <label><input type="checkbox" checked={presentation[key] ?? true} onchange={(event) => update(key, event.currentTarget.checked)} /> {item[1]}</label>
        {/each}
      </div>
    </fieldset>
    <fieldset>
      <legend>Displays</legend>
      {#each state.topology as display (display.id)}
        <div class="display-row"><code>{display.id}</code><select aria-label={`Device for ${display.id}`} value={deviceFor(display.id)} onchange={(event) => updateDevice(display.id, event.currentTarget.value as "laptop" | "display")}><option value="laptop">Laptop</option><option value="display">Desktop display</option></select><button type="button" disabled={busy || state.topology.length === 1} onclick={() => onremovedisplay(display.id)}>Remove</button></div>
      {/each}
      <button type="button" disabled={busy || state.topology.length >= 16} onclick={onadddisplay}>Add display</button>
    </fieldset>
  </div>
</details>

<style>
  .advanced { border: 1px solid var(--color-line-default); border-radius: 0.75rem; background: var(--color-surface-raised); }
  summary { cursor: pointer; padding: 0.85rem 1rem; font-weight: 650; }
  .content { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem; border-top: 1px solid var(--color-line-default); padding: 1rem; }
  fieldset { min-width: 0; margin: 0; border: 0; padding: 0; } legend { margin-bottom: 0.6rem; font-weight: 650; }
  .checks { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.5rem; } label, .state { color: var(--color-page-secondary); font: 0.8rem/1.4 var(--type-family-system); }
  .actions, .display-row { display: flex; align-items: center; gap: 0.4rem; } .display-row { margin-bottom: 0.45rem; } code { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; }
  button, select { min-height: var(--control-target); border: 1px solid var(--color-line-strong); border-radius: var(--radius-control); padding: 0.45rem 0.65rem; background: var(--color-surface-base); color: inherit; } button:not(:disabled) { cursor: pointer; } button:disabled { opacity: 0.5; }
  :is(button, select, summary, input):focus-visible { outline: 2px solid var(--color-focus-ring); outline-offset: 2px; }
  @media (max-width: 52rem) { .content { grid-template-columns: 1fr; } }
</style>
