<script lang="ts">
  let { clipId }: { clipId: string } = $props();

  const titleId = $derived(`${clipId}-title`);
  const descriptionId = $derived(`${clipId}-description`);
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  viewBox="0 0 516 72"
  role="img"
  aria-labelledby={`${titleId} ${descriptionId}`}
>
  <title id={titleId}>Paneform WM</title>
  <desc id={descriptionId}>Paneform WM horizontal logo lockup.</desc>
  <defs>
    <clipPath id={clipId}>
      <rect x="4" y="4" width="64" height="64" rx="14" />
    </clipPath>
  </defs>
  <rect class="black" x="4" y="4" width="64" height="64" rx="14" />
  <rect class="white" x="4" y="4" width="64" height="14" clip-path={`url(#${clipId})`} />
  <rect class="white" x="10" y="20" width="25" height="41" rx="5" />
  <rect class="cyan" x="37" y="20" width="25" height="24" rx="5" />
  <rect class="white" x="37" y="46" width="25" height="15" rx="5" />
  <g class="wordmark">
    <text x="88" y="54" font-size="68" font-weight="650" letter-spacing="-2.5">paneform</text>
    <text class="bright-black" x="386" y="54" font-size="68" font-weight="500" letter-spacing="-2"
      >wm</text
    >
  </g>
</svg>

<style>
  svg {
    display: block;
    --pf-black: #26233a;
    --pf-white: #e0def4;
    --pf-cyan: #ebbcba;
    --pf-bright-black: #6e6a86;
  }
  .wordmark {
    fill: var(--ansi-white, var(--pf-white));
    font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .black { fill: var(--ansi-black, var(--pf-black)); }
  .white { fill: var(--ansi-white, var(--pf-white)); }
  .cyan { fill: var(--ansi-cyan, var(--pf-cyan)); }
  .bright-black { fill: var(--ansi-bright-black, var(--pf-bright-black)); }

  @media (prefers-color-scheme: light) {
    svg {
      --pf-black: #f2e9e1;
      --pf-white: #575279;
      --pf-cyan: #d7827e;
      --pf-bright-black: #9893a5;
    }
  }
</style>
