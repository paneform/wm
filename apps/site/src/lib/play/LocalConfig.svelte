<script lang="ts">
  import type { Config } from "@paneform/layout";
  import { LOCAL_CONFIG_PICKER_ID, loadLocalConfigFile, RECOMMENDED_CONFIG_PATH } from "./local-config.js";

  interface OpenFilePickerOptions {
    id: string;
    multiple: boolean;
    types: Array<{ description: string; accept: Record<string, string[]> }>;
  }
  type OpenFilePicker = (options: OpenFilePickerOptions) => Promise<FileSystemFileHandle[]>;

  let { onload, disabled = false }: { onload: (config: Config) => Promise<boolean>; disabled?: boolean } = $props();
  let input = $state<HTMLInputElement>();
  let busy = $state(false);
  let status = $state("");
  let error = $state("");

  async function apply(file: File) {
    busy = true; error = ""; status = "";
    try {
      const accepted = await onload(await loadLocalConfigFile(file));
      if (accepted) status = `${file.name} loaded.`;
      else error = "The scenario could not apply this config.";
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "The config could not be loaded.";
    } finally { busy = false; }
  }

  async function choose() {
    // SAFETY: This optional API is feature-detected before it is called.
    const picker = (window as Window & { showOpenFilePicker?: OpenFilePicker }).showOpenFilePicker;
    if (!picker) { input?.click(); return; }
    try {
      const [handle] = await picker.call(window, { id: LOCAL_CONFIG_PICKER_ID, multiple: false, types: [{ description: "Paneform config", accept: { "application/json": [".json", ".jsonc"] } }] });
      if (handle) await apply(await handle.getFile());
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) error = "The file picker could not be opened.";
    }
  }

  async function copyPath() {
    try { await navigator.clipboard.writeText(RECOMMENDED_CONFIG_PATH); status = "Recommended path copied."; }
    catch { error = "Could not copy the path."; }
  }
</script>

<section class="local-config" aria-labelledby="local-config-title">
  <div><strong id="local-config-title">Local config</strong><p>Choose <code>{RECOMMENDED_CONFIG_PATH}</code> or another JSON/JSONC config. In the macOS picker, use Command-Shift-G to enter the path. Browsers cannot select that folder or file automatically.</p><p>The selected config stays in this browser and is included if you export or share the scenario. Loading it resets playback to the starting layout.</p></div>
  <div class="actions"><button type="button" disabled={busy || disabled} onclick={choose}>{busy ? "Loading..." : "Load local config"}</button><button class="secondary" type="button" onclick={copyPath}>Copy path</button></div>
  <input bind:this={input} class="file-input" type="file" accept=".json,.jsonc,application/json" onchange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void apply(file); event.currentTarget.value = ""; }} />
  {#if status}<p class="status" role="status">{status}</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
  .local-config { display: grid; gap: 0.7rem; border: 1px solid var(--color-line-default); border-radius: 0.75rem; padding: 1rem; background: var(--color-surface-raised); }
  p { margin: 0.25rem 0 0; color: var(--color-page-secondary); font: 0.8rem/1.45 var(--type-family-system); }
  code { overflow-wrap: anywhere; }
  .actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  button { min-height: var(--control-target); border: 1px solid var(--color-line-strong); border-radius: var(--radius-control); padding: 0.45rem 0.7rem; background: var(--color-action-background); color: var(--color-action-foreground); cursor: pointer; }
  button.secondary { background: var(--color-surface-base); color: var(--color-page-foreground); }
  button:disabled { cursor: wait; opacity: 0.55; }
  button:focus-visible { outline: 2px solid var(--color-focus-ring); outline-offset: 2px; }
  .file-input { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .status { color: var(--color-page-secondary); }
  .error { color: var(--rp-love); }
</style>
