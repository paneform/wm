<script lang="ts">
  import { commandPaths } from "@paneform/layout";
  import { heroKeyboardChords, keyboardKeys, type KeyboardKey } from "$lib/design/tokens.js";
  import KeyboardKeyFace from "./KeyboardKeyFace.svelte";
  import { HERO_WORKSPACES } from "./workspace-model.js";

  const id = $props.id();
  let dismissed = $state<string | null>(null);
  const keyById = new Map(keyboardKeys.map((key) => [key.id, key]));
  function key(id: string): KeyboardKey {
    const data = keyById.get(id);
    if (!data) throw new Error(`Unknown shortcut key: ${id}`);
    const face = { ...data };
    delete face.alternateLegend;
    if (id === "lshift" || id === "rshift") {
      face.legend = id === "lshift" ? "L ⇧" : "R ⇧";
      face.width = 1.65;
    }
    return face;
  }
  function help(prefix: string): string {
    const path = commandPaths.find(({ tokens }) =>
      tokens.map((token) => token.kind === "literal" ? token.value : `<${token.slot}>`).join(" ") === prefix,
    );
    if (!path?.description) throw new Error(`Missing command help: ${prefix}`);
    return path.description;
  }
  const directionalRows = heroKeyboardChords.filter((chord) => chord.primary);
  const workspaceKeys = [{ ...key("0"), legend: "0–9 / A–Z", width: 4 }];
  const excluded = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").filter((letter) =>
    !HERO_WORKSPACES.some((workspace) => workspace === letter),
  ).join(", ");
  const rows = [
    { id: "workspace", modifiers: [key("rshift")], keys: workspaceKeys, action: "Focus workspace", help: help("workspace focus <workspace>") },
    { id: "move-workspace", modifiers: [key("lshift"), key("rshift")], keys: workspaceKeys, action: "Move window to workspace", help: help("workspace move-window <workspace>") },
    ...directionalRows.map((chord) => {
      const direction = "direction" in chord.command ? chord.command.direction : "";
      const aliases = heroKeyboardChords.filter((candidate) =>
        !candidate.primary && candidate.command.type === chord.command.type &&
        "direction" in candidate.command && candidate.command.direction === direction
      );
      return {
        id: chord.id,
        modifiers: chord.keys.slice(0, -1).map(key),
        keys: [chord.trigger, ...aliases.map(({ trigger }) => trigger)].map(key),
        action: `${chord.command.type === "moveDirection" ? "Move" : "Focus"} window ${direction}`,
        help: help(`window ${chord.command.type === "moveDirection" ? "move" : "focus"} ${direction}`),
      };
    }),
  ];
</script>

<!-- The scroll region is focusable so keyboard users can scroll it. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<section class="shortcuts" aria-label="Keyboard shortcuts" tabindex="0">
  <h2>Keyboard shortcuts</h2>
  <p class="intro">Workspace keys exclude {excluded}.<br />L ⇧ and R ⇧ mean left and right Shift.</p>
  <table>
    <thead><tr><th scope="col">Hotkey</th><th scope="col">Action</th></tr></thead>
    <tbody>
      {#each rows as row}
        <tr>
          <td>
            <span class="chord">
              {#each row.modifiers as modifier}
                <KeyboardKeyFace keyData={modifier} surface="screen" ariaLabel={modifier.id === "lshift" ? "left shift" : "right shift"} />
                <span class="plus" aria-hidden="true">+</span>
              {/each}
              <span class="alternatives" aria-label={row.keys === workspaceKeys ? `0–9 or A–Z, except ${excluded}` : row.keys.map(({ legend }) => legend).join(" or ")}>
                {#each row.keys as keyData, index}{#if index > 0}<span class="plus">or</span>{/if}<KeyboardKeyFace {keyData} surface="screen" />{/each}
              </span>
            </span>
          </td>
          <td class="action-cell">
            <button type="button" class="action" aria-describedby={`${id}-${row.id}`}
              onpointerenter={() => dismissed = null} onfocus={() => dismissed = null}
              onkeydown={(event) => { if (event.key === "Escape") { dismissed = row.id; event.stopPropagation(); } }}
            >{row.action}</button>
            <span class="tooltip" class:dismissed={dismissed === row.id} id={`${id}-${row.id}`} role="tooltip">{row.help}</span>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</section>

<style>
  .shortcuts { flex: 1; min-height: 0; min-width: 0; overflow: auto; overscroll-behavior: contain; padding: 1.2em; font: 400 clamp(0.45rem, 0.85vw, 0.68rem)/1.5 var(--type-family-product); scrollbar-width: thin; scrollbar-color: var(--rp-muted) transparent; }
  .shortcuts:focus-visible { outline: 1px solid var(--color-focus-ring); outline-offset: -3px; }
  h2 { margin: 0; font-size: 1.3em; font-weight: 600; letter-spacing: -0.02em; }
  .intro { margin: 0.2em 0 1em; color: var(--color-page-secondary); }
  table { width: 100%; border-collapse: collapse; text-align: left; }
  th { color: var(--color-page-secondary); font-size: 0.85em; font-weight: 500; }
  th, td { padding: 0.9em 0; border-bottom: 1px solid var(--color-line-default); }
  th:first-child, td:first-child { padding-right: 1em; }
  .chord, .alternatives { display: flex; align-items: center; gap: 0.3em; }
  .chord { width: max-content; font-size: 0.72em; }
  .plus { color: var(--color-page-secondary); }
  .action-cell { position: relative; min-width: 7em; }
  .action { border: 0; padding: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: help; text-decoration: underline dotted var(--rp-muted); text-underline-offset: 0.3em; }
  .action:hover, .action:focus-visible { color: var(--rp-rose); }
  .tooltip { position: absolute; z-index: 4; right: 0; bottom: calc(100% - 0.3em); width: 19em; max-width: 50vw; padding: 0.7em 0.9em; border: 1px solid var(--color-line-default); border-radius: 0.5em; background: var(--rp-overlay); color: var(--color-page-foreground); box-shadow: 0 0.3em 1em #0004; visibility: hidden; opacity: 0; }
  .action-cell:has(.action:hover) .tooltip:not(.dismissed), .action-cell:has(.action:focus-visible) .tooltip:not(.dismissed), .tooltip:hover:not(.dismissed) { visibility: visible; opacity: 1; }
</style>
