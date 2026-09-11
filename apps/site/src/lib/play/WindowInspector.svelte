<script lang="ts" module>
  export type WindowConstraintDraft = {
    minWidth: string;
    maxWidth: string;
    minHeight: string;
    maxHeight: string;
  };

  export function validateWindowConstraints(draft: WindowConstraintDraft) {
    const constraints: Record<string, number> = {};
    for (const [key, text] of Object.entries(draft)) {
      if (text.trim() === "") continue;
      const value = Number(text);
      if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a positive number.`);
      constraints[key] = value;
    }
    if ((constraints.minWidth ?? 0) > (constraints.maxWidth ?? Infinity))
      throw new Error("Minimum width must not exceed maximum width.");
    if ((constraints.minHeight ?? 0) > (constraints.maxHeight ?? Infinity))
      throw new Error("Minimum height must not exceed maximum height.");
    return constraints;
  }
</script>

<script lang="ts">
  import type { SimulationWindow } from "@paneform/layout-browser";

  let {
    window,
    editable = true,
    onsave,
    onclose,
  }: {
    window: SimulationWindow | null;
    editable?: boolean;
    onsave: (window: SimulationWindow) => void | Promise<void>;
    onclose: () => void;
  } = $props();

  let draft = $state<WindowConstraintDraft>({ minWidth: "", maxWidth: "", minHeight: "", maxHeight: "" });
  let error = $state("");
  let observed: SimulationWindow | null = null;

  function resetFromWindow(value: SimulationWindow | null) {
    observed = value;
    const limits = value?.constraints;
    draft = {
      minWidth: limits?.minWidth?.toString() ?? "",
      maxWidth: limits?.maxWidth?.toString() ?? "",
      minHeight: limits?.minHeight?.toString() ?? "",
      maxHeight: limits?.maxHeight?.toString() ?? "",
    };
    error = "";
  }

  $effect(() => {
    if (window !== observed) resetFromWindow(window);
  });

  function clearBounds() {
    draft = { minWidth: "", maxWidth: "", minHeight: "", maxHeight: "" };
    error = "";
  }

  function updateBound(field: keyof WindowConstraintDraft, value: string) {
    draft = { ...draft, [field]: value };
  }

  async function save() {
    if (!window || !editable) return;
    try {
      const constraints = validateWindowConstraints(draft);
      error = "";
      await onsave({ ...window, constraints });
    } catch (cause) {
      error = (cause instanceof Error ? cause.message : "Could not save constraints.").slice(0, 2_000);
    }
  }
</script>

{#if window}
  <aside aria-labelledby="window-inspector-title">
    <header>
      <div><small>Selected window</small><h2 id="window-inspector-title">{window.title ?? window.id}</h2><code>{window.id}</code></div>
      <button type="button" onclick={onclose} aria-label="Close window inspector">Close</button>
    </header>
    {#if !editable}<p class="notice">Return to starting layout to edit constraints</p>{/if}
    <form onsubmit={(event) => { event.preventDefault(); void save(); }}>
      <fieldset disabled={!editable}>
        <legend>Size constraints</legend>
        <div class="grid">
          <label>Minimum width<input type="number" min="0" step="any" value={draft.minWidth} oninput={(event) => updateBound("minWidth", event.currentTarget.value)} placeholder="Unset" /></label>
          <label>Maximum width<input type="number" min="0" step="any" value={draft.maxWidth} oninput={(event) => updateBound("maxWidth", event.currentTarget.value)} placeholder="Unset" /></label>
          <label>Minimum height<input type="number" min="0" step="any" value={draft.minHeight} oninput={(event) => updateBound("minHeight", event.currentTarget.value)} placeholder="Unset" /></label>
          <label>Maximum height<input type="number" min="0" step="any" value={draft.maxHeight} oninput={(event) => updateBound("maxHeight", event.currentTarget.value)} placeholder="Unset" /></label>
        </div>
      </fieldset>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <div class="actions"><button type="button" disabled={!editable} onclick={clearBounds}>Reset bounds</button><button class="primary" type="submit" disabled={!editable}>Save</button></div>
    </form>
  </aside>
{/if}

<style>
  aside { width: min(100%, 28rem); border: 1px solid var(--color-line-default); border-radius: 0.75rem; padding: 1rem; background: var(--color-surface-raised); color: var(--color-page-foreground); }
  header, .actions { display: flex; align-items: start; justify-content: space-between; gap: 1rem; }
  small, label { color: var(--color-page-secondary); font: 0.78rem/1.4 var(--type-family-system); }
  h2 { margin: 0.15rem 0; font-size: 1.1rem; } code { color: var(--rp-rose); font-size: 0.75rem; }
  fieldset { margin: 1rem 0; border: 0; padding: 0; } legend { margin-bottom: 0.65rem; font-weight: 650; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.65rem; }
  label { display: grid; gap: 0.25rem; } input { min-width: 0; border: 1px solid var(--color-line-default); border-radius: var(--radius-control); padding: 0.6rem; background: var(--color-surface-base); color: inherit; }
  button { min-height: var(--control-target); border: 1px solid var(--color-line-strong); border-radius: var(--radius-control); padding: 0.55rem 0.8rem; background: var(--color-surface-raised); color: inherit; cursor: pointer; }
  button.primary { border-color: var(--color-action-background); background: var(--color-action-background); color: var(--color-action-foreground); }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--color-focus-ring); outline-offset: 2px; }
  .actions { justify-content: flex-end; } .notice { color: var(--rp-gold); } .error { color: var(--rp-love); }
  @media (max-width: 30rem) { .grid { grid-template-columns: 1fr; } }
</style>
