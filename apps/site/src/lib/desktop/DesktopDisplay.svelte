<script lang="ts">
  import type { Snippet } from "svelte";
  let { screen, powered = true, motion = true, paused = false, class: className = "" }: { screen: Snippet; powered?: boolean; motion?: boolean; paused?: boolean; class?: string; } = $props();
</script>
<div class={`desktop-display ${className}`} class:powered class:motion class:paused>
  <div class="studio-shell"><div class="studio-bezel"><div class="studio-screen">{@render screen()}<div class="power-line"></div></div></div></div><div class="studio-power"></div><div class="studio-home"></div>
</div>
<style>
  .desktop-display { position: relative; width: 100%; aspect-ratio: var(--studio-total-aspect); pointer-events: none; } .paused,.paused * { animation-play-state: paused !important; }
  .studio-shell { width: 100%; aspect-ratio: var(--studio-shell-aspect); padding: var(--stroke-strong); border: var(--stroke-hairline) solid var(--color-line-strong); border-radius: var(--radius-monitor-shell); background: var(--device-shell-gradient); box-shadow: inset 0 0 0 var(--stroke-hairline) var(--color-device-rim), var(--shadow-device); }
  .studio-bezel { width: 100%; height: 100%; padding: var(--studio-bezel); border-radius: calc(var(--radius-monitor-shell) - var(--stroke-hairline)); background: var(--color-display-bezel); box-shadow: inset 0 0 var(--space-1) color-mix(in srgb, var(--color-display-bezel-shadow) 38%, transparent); }
  .studio-screen { position: relative; width: 100%; height: 100%; overflow: hidden; border-radius: var(--radius-monitor-screen); background: var(--color-screen-off); pointer-events: auto; --radius-screen-window: var(--radius-monitor-screen); }
  .studio-screen :global(.display-surface) { opacity: 0; } .powered .studio-screen :global(.display-surface) { opacity: 1; } .motion.powered .studio-screen :global(.display-surface) { transition: opacity var(--motion-feedback); }
  .power-line { position: absolute; inset: 50% 50% auto; height: var(--stroke-strong); background: var(--color-state-connected); transform: translate(-50%, -50%) scaleX(0); } .motion.powered .power-line { animation: power-on var(--motion-power) var(--easing-standard) both; }
  .studio-power::before,.studio-power::after { display: block; width: var(--studio-stand-width); margin-inline: auto; content: ""; } .studio-power { height: calc(var(--studio-stand-height) + var(--studio-base-height)); } .studio-power::before { height: var(--studio-power-stand-height); background: var(--studio-stand-gradient); } .studio-power::after { height: var(--studio-power-base-height); border-block-start: var(--stroke-hairline) solid var(--color-device-rim); background: var(--studio-base-gradient); }
  .studio-home { position: relative; width: 100%; height: var(--studio-feet-height); pointer-events: none; } .studio-home::before,.studio-home::after { position: absolute; inset-block-end: 0; width: var(--studio-feet-width); height: 100%; border-end-start-radius: var(--studio-feet-radius) 100%; border-end-end-radius: var(--studio-feet-radius) 100%; background: var(--color-device-shade); content: ""; } .studio-home::before { inset-inline-start: var(--studio-left-foot-left); } .studio-home::after { inset-inline-start: var(--studio-right-foot-left); }
  @keyframes power-on { 0% { transform: translate(-50%, -50%) scaleX(0); opacity: 1; } 45% { transform: translate(-50%, -50%) scaleX(1); opacity: 1; } 100% { transform: translate(-50%, -50%) scale(1,160); opacity: 0; } }
</style>
