<script lang="ts">
  import { page } from "$app/state";
  import { onMount, tick } from "svelte";
  import { railPath, straightRange, type RailPoint } from "./toc-rail.js";

  interface Entry { id: string; text: string; level: number; element: HTMLElement }
  let entries = $state<Entry[]>([]);
  let active = $state(0);
  let path = $state("");
  let railHeight = $state(1);
  let list = $state<HTMLUListElement>();
  let track = $state<SVGPathElement>();
  let progress = $state<SVGPathElement>();
  let marker = $state<SVGPathElement>();
  let frame = 0;
  let segments: { start: number; end: number; total: number }[] = [];

  function refresh() {
    const headings = [...document.querySelectorAll<HTMLElement>("#docs-main h2[id], #docs-main h3[id]")];
    if (headings.length === entries.length && headings.every((heading, index) =>
      heading === entries[index]?.element && heading.textContent === entries[index]?.text)) return;
    entries = headings.map((element) => ({ id: element.id, text: element.textContent?.trim() ?? "", level: Number(element.tagName[1]), element }));
    active = 0;
    void tick().then(measure);
  }

  function lengthAt(y: number, total: number, rail: SVGPathElement) {
    let low = 0, high = total;
    for (let i = 0; i < 16; i++) {
      const middle = (low + high) / 2;
      if (rail.getPointAtLength(middle).y < y) low = middle;
      else high = middle;
    }
    return (low + high) / 2;
  }

  async function measure() {
    if (!list || !track || !entries.length || !list.offsetHeight) return;
    const rows = [...list.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
    const points: RailPoint[] = rows.map((row, index) => ({ x: entries[index]!.level === 3 ? 14 : 2, y: row.offsetTop + row.offsetHeight / 2 }));
    railHeight = list.offsetHeight;
    path = railPath(points, railHeight);
    await tick();
    const rail = track;
    if (!rail) return;
    const total = rail.getTotalLength();
    segments = rows.map((row, index) => {
      const range = straightRange(points, index, row.offsetTop, row.offsetTop + row.offsetHeight);
      return { start: lengthAt(range.start, total, rail), end: lengthAt(range.end, total, rail), total };
    });
    updateCurrent();
    updateMarker();
    updateProgress();
  }

  function updateMarker() {
    const segment = segments[active];
    if (!segment || !marker) return;
    marker.style.strokeDasharray = `${segment.end - segment.start} ${segment.total + 1}`;
    marker.style.strokeDashoffset = String(-segment.start);
  }

  function updateProgress() {
    if (!progress) return;
    const maximum = document.documentElement.scrollHeight - window.innerHeight;
    progress.style.strokeDashoffset = String(1 - (maximum > 0 ? window.scrollY / maximum : 0));
  }

  function updateCurrent() {
    frame = 0;
    const threshold = Math.min(window.innerHeight / 2, 320);
    const next = entries.reduce((index, entry, position) => entry.element.getBoundingClientRect().top <= threshold ? position : index, 0);
    if (active !== next) { active = next; updateMarker(); }
    updateProgress();
  }

  function queueUpdate() { if (!frame) frame = requestAnimationFrame(updateCurrent); }

  onMount(() => {
    const main = document.getElementById("docs-main");
    const mutation = new MutationObserver(refresh);
    if (main) mutation.observe(main, { childList: true, subtree: true, characterData: true });
    const resize = new ResizeObserver(() => void measure());
    if (list) resize.observe(list);
    window.addEventListener("scroll", queueUpdate, { passive: true });
    window.addEventListener("resize", queueUpdate);
    window.addEventListener("resize", measure);
    refresh();
    return () => {
      mutation.disconnect(); resize.disconnect(); cancelAnimationFrame(frame);
      window.removeEventListener("scroll", queueUpdate);
      window.removeEventListener("resize", queueUpdate);
      window.removeEventListener("resize", measure);
    };
  });

  $effect(() => { if (page.url.pathname.startsWith("/wm/docs")) void tick().then(refresh); });
</script>

<aside class="docs-toc" aria-label="On this page">
  <p>On this page</p>
  <div class="docs-toc-links">
    <svg aria-hidden="true" viewBox={`0 0 18 ${railHeight}`} preserveAspectRatio="none">
      <path class="toc-track" d={path} bind:this={track} />
      <path class="toc-progress" d={path} pathLength="1" bind:this={progress} />
      <path class="toc-active" d={path} bind:this={marker} />
    </svg>
    <ul bind:this={list}>
      {#each entries as entry, index (entry.id)}
        <li class:nested={entry.level === 3}><a href={`#${entry.id}`} aria-current={active === index ? "location" : undefined}>{entry.text}</a></li>
      {/each}
    </ul>
  </div>
</aside>
