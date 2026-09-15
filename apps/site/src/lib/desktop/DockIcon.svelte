<script lang="ts">
  import type { AppIcon } from "./desktop-model.js";

  let { icon }: { icon: AppIcon | undefined } = $props();
  const instanceId = $props.id();
  const clipId = `paneform-icon-clip-${instanceId}`;
</script>

<svg viewBox={icon === "paneform" ? "0 0 64 64" : "0 0 24 24"} aria-hidden="true">
  {#if icon === "paneform"}
    <defs><clipPath id={clipId}><rect width="64" height="64" rx="14" /></clipPath></defs>
    <g class="paneform-icon">
      <rect width="64" height="64" rx="14" fill="var(--ansi-black, var(--pf-black))" />
      <rect width="64" height="14" fill="var(--ansi-white, var(--pf-white))" clip-path={`url(#${clipId})`} />
      <rect x="6" y="16" width="25" height="41" rx="5" fill="var(--ansi-white, var(--pf-white))" />
      <rect x="33" y="16" width="25" height="24" rx="5" fill="var(--ansi-cyan, var(--pf-cyan))" />
      <rect x="33" y="42" width="25" height="15" rx="5" fill="var(--ansi-white, var(--pf-white))" />
    </g>
  {:else if icon === "waitlist"}<rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 6 9 7 9-7" />
  {:else if icon === "messages"}<path d="M5 17.5 3.5 21l4.2-1.7a9 9 0 1 0-2.7-1.8Z" />
  {:else if icon === "contacts"}<circle cx="12" cy="8" r="3.5" /><path d="M5.5 20c.7-3.4 3-5.3 6.5-5.3s5.8 1.9 6.5 5.3" />
  {:else if icon === "browser"}<circle cx="12" cy="12" r="9" /><path d="M3.5 9h17M3.5 15h17M12 3c2.2 2.4 3.3 5.4 3.3 9S14.2 18.6 12 21M12 3C9.8 5.4 8.7 8.4 8.7 12s1.1 6.6 3.3 9" />
  {:else if icon === "text-editor"}<path d="M6 3h8l4 4v14H6Z" /><path d="M14 3v5h4M9 12h6M9 16h6" />
  {:else if icon === "terminal"}<rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M12.5 15H17" />
  {:else if icon === "music"}<path d="M9 18V5l11-2v13M9 9l11-2" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" />
  {:else if icon === "settings"}<path d="M9.7 2h4.6l.6 2.4a8.2 8.2 0 0 1 1.4.8l2.4-.7 2.3 4-1.8 1.7a8.2 8.2 0 0 1 0 1.6l1.8 1.7-2.3 4-2.4-.7a8.2 8.2 0 0 1-1.4.8l-.6 2.4H9.7l-.6-2.4a8.2 8.2 0 0 1-1.4-.8l-2.4.7-2.3-4 1.8-1.7a8.2 8.2 0 0 1 0-1.6L3 8.5l2.3-4 2.4.7a8.2 8.2 0 0 1 1.4-.8Z" /><circle cx="12" cy="11" r="3" />
  {:else}<text x="12" y="16" text-anchor="middle">?</text>{/if}
</svg>

<style>
  svg { display: block; width: 100%; height: 100%; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.7; }
  text { fill: currentColor; stroke: none; font: 700 14px sans-serif; }
  .paneform-icon { --pf-black: #26233a; --pf-white: #e0def4; --pf-cyan: #ebbcba; stroke: none; }
  @media (prefers-color-scheme: light) { .paneform-icon { --pf-black: #f2e9e1; --pf-white: #575279; --pf-cyan: #d7827e; } }
</style>
