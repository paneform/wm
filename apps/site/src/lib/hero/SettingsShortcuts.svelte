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
  type Binding = {
    modifiers: KeyboardKey[];
    label: string;
  } & (
    | { keys: [KeyboardKey, KeyboardKey]; range: true }
    | { keys: [KeyboardKey]; range: false }
  );
  function rangeBinding(modifiers: KeyboardKey[], keys: [KeyboardKey, KeyboardKey], label: string): Binding {
    return { modifiers, keys, range: true, label };
  }
  function singleBinding(modifiers: KeyboardKey[], keyData: KeyboardKey): Binding {
    return { modifiers, keys: [keyData], range: false, label: keyData.legend };
  }
  const directionalRows = heroKeyboardChords.filter((chord) => chord.primary);
  const workspaceKeys = [key("0"), key("9"), key("a"), key("z")] as const;
  const excluded = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").filter((letter) =>
    !HERO_WORKSPACES.some((workspace) => workspace === letter),
  ).join(", ");
  const rows = [
    {
      id: "workspace",
      bindings: [
        rangeBinding([key("rshift")], [workspaceKeys[0], workspaceKeys[1]], "0–9"),
        rangeBinding([key("rshift")], [workspaceKeys[2], workspaceKeys[3]], `A–Z, except ${excluded}`),
      ],
      action: "focus workspace",
      help: help("workspace focus <workspace>"),
    },
    {
      id: "move-workspace",
      bindings: [
        rangeBinding([key("lshift"), key("rshift")], [workspaceKeys[0], workspaceKeys[1]], "0–9"),
        rangeBinding([key("lshift"), key("rshift")], [workspaceKeys[2], workspaceKeys[3]], `A–Z, except ${excluded}`),
      ],
      action: "move window to workspace",
      help: help("workspace move-window <workspace>"),
    },
    ...directionalRows.map((chord) => {
      const direction = "direction" in chord.command ? chord.command.direction : "";
      const aliases = heroKeyboardChords.filter((candidate) =>
        !candidate.primary && candidate.command.type === chord.command.type &&
        "direction" in candidate.command && candidate.command.direction === direction
      );
      return {
        id: chord.id,
        bindings: [chord.trigger, ...aliases.map(({ trigger }) => trigger)].map((trigger) =>
          singleBinding(chord.keys.slice(0, -1).map(key), key(trigger))
        ),
        action: `${chord.command.type === "moveDirection" ? "move" : "focus"} window ${direction}`,
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
          <td class="bindings-cell">
            <span class="bindings">
              {#each row.bindings as binding}
                <span class="chord">
                  <span class="modifiers">
                    {#each binding.modifiers as modifier}
                      <KeyboardKeyFace keyData={modifier} surface="screen" ariaLabel={modifier.id === "lshift" ? "left shift" : "right shift"} />
                      <span class="plus" aria-hidden="true">+</span>
                    {/each}
                  </span>
                  <span class="alternative" aria-label={binding.label}>
                    {#if binding.range}
                      <span aria-hidden="true">(</span>
                      <KeyboardKeyFace keyData={binding.keys[0]} surface="screen" /><span aria-hidden="true">–</span><KeyboardKeyFace keyData={binding.keys[1]} surface="screen" />
                      <span aria-hidden="true">)</span>
                    {:else}
                      <KeyboardKeyFace keyData={binding.keys[0]} surface="screen" />
                    {/if}
                  </span>
                </span>
              {/each}
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
  .shortcuts { flex: 1; min-height: 0; min-width: 0; overflow-y: auto; overscroll-behavior: contain; padding: 1.2em; font: 400 clamp(0.45rem, 0.85vw, 0.68rem)/1.5 var(--type-family-product); scrollbar-width: thin; scrollbar-color: var(--rp-muted) transparent; }
  .shortcuts:focus-visible { outline: 1px solid var(--color-focus-ring); outline-offset: -3px; }
  h2 { margin: 0; font-size: 1.3em; font-weight: 600; letter-spacing: -0.02em; }
  .intro { margin: 0.2em 0 1em; color: var(--color-page-secondary); }
  table { width: 100%; table-layout: fixed; border-collapse: collapse; text-align: left; }
  th { color: var(--color-page-secondary); font-size: 0.85em; font-weight: 500; }
  th, td { padding: 0.9em 0; border-bottom: 1px solid var(--color-line-default); }
  th:first-child, td:first-child { width: 68%; padding-right: 1em; }
  td { min-width: 0; vertical-align: middle; }
  .bindings { display: flex; min-width: 0; flex-direction: column; align-items: flex-start; gap: 0.55em; }
  .chord { display: flex; max-width: 100%; flex-wrap: wrap; align-items: center; gap: 0.3em; font-size: 1em; --key-named-label: 0.72em; }
  .modifiers, .alternative { display: inline-flex; flex: none; align-items: center; gap: 0.3em; }
  .plus { color: var(--color-page-secondary); }
  .action-cell { position: relative; min-width: 0; overflow-wrap: anywhere; }
  .action { max-width: 100%; border: 0; padding: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: help; text-decoration: underline dotted var(--rp-muted); text-underline-offset: 0.3em; }
  .action:hover, .action:focus-visible { color: var(--rp-rose); }
  .tooltip { position: absolute; z-index: 4; right: 0; bottom: calc(100% - 0.3em); width: 19em; max-width: 50vw; padding: 0.7em 0.9em; border: 1px solid var(--color-line-default); border-radius: 0.5em; background: var(--rp-overlay); color: var(--color-page-foreground); box-shadow: 0 0.3em 1em #0004; visibility: hidden; opacity: 0; }
  .action-cell:has(.action:hover) .tooltip:not(.dismissed), .action-cell:has(.action:focus-visible) .tooltip:not(.dismissed), .tooltip:hover:not(.dismissed) { visibility: visible; opacity: 1; }
</style>
