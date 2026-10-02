<script lang="ts">
  const lines = [
    "$ wm permissions",
    "{",
    '  "accessibility": "granted",',
    '  "screenRecording": "granted"',
    "}",
  ];
  let visible = $state(0);
  let playing = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  function stop() { if (timer) clearTimeout(timer); timer = undefined; playing = false; }
  function advance() {
    visible += 1;
    if (visible >= lines.length) { stop(); return; }
    timer = setTimeout(advance, 330);
  }
  function toggle() {
    if (playing) { stop(); return; }
    if (visible === lines.length) visible = 0;
    playing = true;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { visible = lines.length; stop(); }
    else advance();
  }
</script>
<div class="terminal-stage">
  <div class="terminal"><pre aria-live="polite">{lines.slice(0, visible).join('\n')}</pre></div>
  <div class="controls"><p>{visible === lines.length ? 'Example: both permissions are granted.' : 'A sample healthy machine, replayed line by line.'}</p><button type="button" onclick={toggle} aria-label={playing ? 'Pause sample' : visible === lines.length ? 'Replay sample' : 'Play sample'}>{playing ? 'Ⅱ' : visible === lines.length ? '↺' : '▶'}</button><span class="rail" style:--progress={`${visible / lines.length * 100}%`}></span><span>{visible}/{lines.length}</span></div>
</div>
<p class="note">Illustrative output. Actual fields and permission states depend on your installation.</p>
<style>
  .terminal-stage { max-width: 40rem; border: 1px solid var(--docs-line); border-radius: var(--radius-control); overflow: hidden; }
  .terminal { min-height: 12rem; padding: 1rem; background: var(--rp-base); }
  .terminal pre { margin: 0; padding: 0; border: 0; color: var(--rp-text); white-space: pre-wrap; }
  .controls { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; padding: .5rem .75rem; border-top: 1px solid var(--docs-line); background: var(--rp-surface); font-size: var(--docs-sm); }
  .controls p { flex-basis: 100%; margin: 0; text-align: center; }
  .controls button { border: 0; border-radius: 50%; background: transparent; color: var(--rp-text); cursor: pointer; padding: .3rem .6rem; }
  .rail { flex: 1; height: 2px; background: linear-gradient(to right, var(--rp-foam) var(--progress), var(--rp-muted) var(--progress)); }
  .note { color: var(--docs-quiet); font-size: var(--docs-xs); }
</style>
