<script lang="ts">
  import { onMount, tick } from "svelte";
  import { createScenarioSession, playbackSteps, type ScenarioSession, type SimulationState } from "@paneform/layout-browser";
  import DemoPreview from "./DemoPreview.svelte";
  import { animateWorkspaceIndicator, captureWorkspaceIndicator } from "./demo-indicator.js";
  import type { DemoSituation } from "./demo-data.js";
  import { carouselSelection, carouselTarget } from "./carousel.js";
  import { DEMO_CAPTION_COLUMNS, formatDemoCaption } from "./demo-caption.js";

  let { situations }: { situations: DemoSituation[] } = $props();
  let stage = $state<HTMLDivElement>();
  let track = $state<HTMLDivElement>();
  let scrollStart = $state(false);
  let scrollEnd = $state(false);
  const id = $props.id();
  let tiles: HTMLButtonElement[] = [];
  let pips: HTMLButtonElement[] = [];
  let snapshots = $state<SimulationState[]>([]);
  let selected = $state(0);
  let playing = $state(false);
  let played = $state(new Set<number>());
  let resetting = $state(false);
  let flash = $state(-1);
  let error = $state("");
  let active = $state(false);
  let userPaused = $state(false);
  let userScrolling = $state(false);
  let loading = false;
  let reducedMotion = $state(false);
  let programmaticScroll = false;
  let userScrolled = false;
  let scrollTimer: ReturnType<typeof setTimeout>;
  const canAutoplay = $derived(active && !userPaused && !userScrolling && !reducedMotion);
  let generation = 0;
  let session: ScenarioSession | null = null;
  let clearMove: (() => void) | null = null;
  let stepTimer: ReturnType<typeof setTimeout>;
  let endTimer: ReturnType<typeof setTimeout>;
  let pauseTimer: ReturnType<typeof setTimeout>;
  let flashTimer: ReturnType<typeof setTimeout>;

  function viewport() {
    return { left: track?.scrollLeft ?? 0, width: track?.clientWidth ?? 0, contentWidth: track?.scrollWidth ?? 0 };
  }

  function updateEdges() {
    if (!track) return;
    const maximum = Math.max(0, track.scrollWidth - track.clientWidth);
    const left = Math.max(0, Math.min(track.scrollLeft, maximum));
    scrollStart = left > 1;
    scrollEnd = maximum - left > 1;
  }

  function reveal(index: number) {
    const tile = tiles[index];
    if (!track || !tile) return;
    const left = carouselTarget(viewport(), { left: tile.offsetLeft, width: tile.offsetWidth });
    if (Math.abs(left - track.scrollLeft) < 1) return;
    programmaticScroll = true;
    track.scrollTo({ left, behavior: reducedMotion ? 'instant' : 'smooth' });
  }

  function suspendAutoplay() { clearTimeout(pauseTimer); }

  function resumeAutoplay() {
    if (!canAutoplay || playing || loading) return;
    suspendAutoplay();
    if (played.has(selected)) pauseTimer = setTimeout(() => { if (canAutoplay) void advance(selected); }, 500);
    else if (session) schedulePlayback(session, selected, generation);
    else void run(selected);
  }

  function schedulePlayback(candidate: ScenarioSession, index: number, token: number) {
    if (!canAutoplay) return;
    pauseTimer = setTimeout(() => {
      if (generation === token && canAutoplay) beginPlayback(candidate, index, token);
    }, 1000);
  }

  function scrollSettled() {
    if (programmaticScroll) { programmaticScroll = false; return; }
    userScrolling = false;
    if (!userScrolled) { resumeAutoplay(); return; }
    userScrolled = false;
    const index = carouselSelection(viewport(), tiles.map((tile) => ({ left: tile.offsetLeft, width: tile.offsetWidth })));
    if (index !== selected) choose(index);
    else resumeAutoplay();
  }

  function scrolling() {
    updateEdges();
    clearTimeout(scrollTimer);
    if (!programmaticScroll) { userScrolled = true; userScrolling = true; suspendAutoplay(); }
    scrollTimer = setTimeout(scrollSettled, 150);
  }

  function browse() {
    programmaticScroll = false; userScrolling = true; suspendAutoplay();
    clearTimeout(scrollTimer); scrollTimer = setTimeout(scrollSettled, 150);
  }

  function keyboard(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); userPaused = true; suspendAutoplay(); return; }
    const controls = event.target instanceof HTMLButtonElement && tiles.includes(event.target) ? tiles : pips;
    const index = event.target instanceof HTMLButtonElement ? controls.indexOf(event.target) : -1;
    if (index < 0) return;
    const next = event.key === 'ArrowRight' ? (index + 1) % situations.length : event.key === 'ArrowLeft' ? (index - 1 + situations.length) % situations.length : event.key === 'Home' ? 0 : event.key === 'End' ? situations.length - 1 : null;
    if (next === null) return;
    event.preventDefault(); controls[next]?.focus({ preventScroll: true }); choose(next);
  }

  function cancel() {
    generation++;
    clearTimeout(stepTimer);
    clearTimeout(endTimer);
    clearTimeout(pauseTimer);
    clearTimeout(flashTimer);
    clearMove?.();
    clearMove = null;
    flash = -1;
    playing = false;
    resetting = false;
    const previous = session;
    session = null;
    void previous?.dispose();
  }

  async function runStep(candidate: ScenarioSession, index: number, token: number) {
    try {
      const result = await candidate.step();
      if (generation !== token || !result) return;
      const focusedId = snapshots[index]?.focusedWindow;
      const origin = focusedId ? captureWorkspaceIndicator(tiles[index]!, focusedId) : null;
      snapshots[index] = result.state;
      await tick();
      if (generation !== token) return;
      clearMove = animateWorkspaceIndicator(tiles[index]!, origin, result.state);
      if (situations[index]!.slug === "exclusive-edge") {
        flash = index;
        flashTimer = setTimeout(() => (flash = -1), 420);
      }
    } catch (cause) {
      if (generation === token) error = cause instanceof Error ? cause.message : "Demo step failed.";
    }
  }

  function beginPlayback(candidate: ScenarioSession, index: number, token: number) {
    playing = true;
    stepTimer = setTimeout(() => void runStep(candidate, index, token), 300);
    endTimer = setTimeout(() => {
      if (generation !== token) return;
      playing = false;
      played = new Set([...played, index]);
      pauseTimer = setTimeout(() => {
        if (generation === token && canAutoplay) void advance(index);
      }, 500);
    }, 1000);
  }

  async function run(index: number, immediate = false) {
    if (!active) return;
    cancel();
    selected = index;
    reveal(index);
    played = new Set([...played].filter((value) => value !== index));
    error = "";
    const token = generation;
    loading = true;
    let candidate: ScenarioSession | null = null;
    try {
      candidate = await createScenarioSession(situations[index]!.scenario);
      if (generation !== token) return;
      session = candidate;
       snapshots[index] = await candidate.snapshot();
      if (generation !== token) return;
      if (immediate) beginPlayback(candidate, index, token);
      else schedulePlayback(candidate, index, token);
    } catch (cause) {
      if (generation === token) error = cause instanceof Error ? cause.message : "Demo could not load.";
    } finally {
      if (generation === token) loading = false;
      if (generation !== token) void candidate?.dispose();
    }
  }

  async function advance(index: number) {
    if (!canAutoplay) return;
    if (index < situations.length - 1) { await run(index + 1); return; }
    cancel();
    const token = generation;
    resetting = true;
    snapshots = situations.map((situation) => situation.scenario.state);
    played = new Set();
    await tick();
    if (generation !== token) return;
    requestAnimationFrame(() => {
      if (generation !== token) return;
      resetting = false;
      if (canAutoplay) void run(0);
    });
  }

  function choose(index: number) {
    userPaused = false;
    const url = new URL(location.href);
    if (index === 0) url.searchParams.delete("demo");
    else url.searchParams.set("demo", situations[index]!.slug);
    history.replaceState(history.state, "", url);
    selected = index;
    if (stage && document.visibilityState === 'visible') {
      const bounds = stage.getBoundingClientRect();
      if (bounds.bottom > 0 && bounds.top < innerHeight) active = true;
    }
    void run(index, true);
  }

  onMount(() => {
    const stageElement = stage;
    if (!stageElement) return;
    snapshots = situations.map((situation) => situation.scenario.state);
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const updateMotion = () => { reducedMotion = motion.matches; if (reducedMotion) suspendAutoplay(); else resumeAutoplay(); };
    reducedMotion = motion.matches;
    motion.addEventListener('change', updateMotion);
    const initial = situations.findIndex((situation) => situation.slug === new URL(location.href).searchParams.get("demo"));
    selected = Math.max(initial, 0);
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting && document.visibilityState === "visible") {
        if (!active) { active = true; void run(selected); }
      } else if (active) { active = false; cancel(); }
    }, { threshold: 0.1 });
    observer.observe(stageElement);
    const resize = new ResizeObserver(updateEdges);
    if (track) resize.observe(track);
    updateEdges();
    const visibility = () => {
      if (document.visibilityState === "hidden") { active = false; cancel(); }
      else if (stageElement.getBoundingClientRect().bottom > 0 && stageElement.getBoundingClientRect().top < innerHeight) {
        active = true;
        void run(selected);
      }
    };
    document.addEventListener("visibilitychange", visibility);
    return () => { observer.disconnect(); resize.disconnect(); motion.removeEventListener('change', updateMotion); clearTimeout(scrollTimer); document.removeEventListener("visibilitychange", visibility); active = false; cancel(); };
  });
</script>

<div class="demo-stage" class:single={situations.length === 1} style:--demo-caption-columns={DEMO_CAPTION_COLUMNS} bind:this={stage} role="region" aria-roledescription="carousel" aria-label="Command examples. Press Escape to pause; select an example to play." data-autoplay={canAutoplay ? 'running' : 'paused'} data-reduced-motion={reducedMotion}>
  <div class="scroller" class:scroll-start={scrollStart} class:scroll-end={scrollEnd}>
  <div class="situations" bind:this={track} role="group" aria-label="Command situations" onscroll={scrolling} onpointerdown={browse} onpointerup={() => { userScrolling = false; resumeAutoplay(); }} onpointercancel={() => { userScrolling = false; resumeAutoplay(); }} onwheel={browse}>
     {#each situations as situation, index (situation.slug)}
       {@const step = playbackSteps(situation.scenario)[0]}
      <button
        bind:this={tiles[index]}
        type="button"
        class:active={selected === index}
        class:playing={selected === index && playing}
        class:played={played.has(index)}
        class:resetting
         aria-label={`${situation.title}: ${situation.intro}`}
         aria-current={selected === index ? 'true' : undefined}
         aria-describedby={`${id}-caption-${index}`}
         onfocus={() => reveal(index)}
         onkeydown={keyboard}
        onclick={() => choose(index)}
      >
        <DemoPreview scenario={situation.scenario} state={snapshots[index] ?? situation.scenario.state} flash={flash === index} />
         <span class="situation-title">{situation.title}</span>
            <span class="step-caption" id={`${id}-caption-${index}`}>{formatDemoCaption(played.has(index) ? step?.caption ?? situation.intro : situation.intro)}</span>
        <span class="progress" aria-hidden="true"></span>
      </button>
    {/each}
  </div>
  </div>
  <div class="carousel-dots" role="group" aria-label="Example navigation">
    {#each situations as situation, index (situation.slug)}
      <button type="button" bind:this={pips[index]} class:active={selected === index}
        aria-current={selected === index ? 'true' : undefined}
        aria-label={`Play example ${index + 1} of ${situations.length}: ${situation.title}`}
        title={situation.title} onkeydown={keyboard}
        onclick={() => choose(index)}></button>
    {/each}
  </div>
  {#if error}<p class="demo-error" role="alert">{error}</p>{/if}
</div>

<style>
  .demo-stage { --demo-card-width: calc(var(--demo-caption-columns) * 1ch + 1.3rem + 2px); --demo-preview-height: 140px; --demo-screen-width: 224px; --demo-raised: var(--rp-overlay); --demo-sunken: var(--rp-surface); max-width: 46rem; font: var(--docs-xs)/1.4 var(--type-family-product); }
  .demo-stage.single { max-width: calc(var(--demo-card-width) + .5rem); }
  .scroller { position: relative; }
  .scroller::before, .scroller::after { content: ''; position: absolute; inset-block: .25rem; width: 12px; z-index: 1; pointer-events: none; opacity: 0; transition: opacity var(--motion-feedback) var(--easing-standard); }
  .scroller::before { inset-inline-start: 0; box-shadow: inset 8px 0 8px -8px color-mix(in srgb, black 24%, transparent); }
  .scroller::after { inset-inline-end: 0; box-shadow: inset -8px 0 8px -8px color-mix(in srgb, black 24%, transparent); }
  .scroller.scroll-start::before, .scroller.scroll-end::after { opacity: 1; }
  .situations { position: relative; display: flex; gap: .25rem; padding: .25rem; overflow-x: auto; overscroll-behavior-x: contain; scroll-snap-type: x mandatory; scroll-padding-inline: .25rem; scrollbar-width: none; }
  .situations::-webkit-scrollbar { display: none; }
  .situations button { flex: 0 0 var(--demo-card-width); position: relative; display: grid; grid-template-rows: var(--demo-preview-height) auto minmax(0, 1fr); gap: .3rem; align-items: start; height: 240px; min-width: 0; padding: .65rem; border: 1px solid var(--docs-line); border-radius: var(--radius-small); background: var(--demo-sunken); color: var(--rp-text); cursor: pointer; font: inherit; scroll-snap-align: start; overflow: hidden; }
  .situations button.active { background: var(--demo-raised); }
  .situations button:focus-visible { outline-offset: -2px; }
    .situation-title { display: block; margin: 0; color: var(--docs-label); font: 600 var(--docs-xs)/1.3 var(--type-family-keyboard); text-align: center; }
    .step-caption { display: block; inline-size: calc(var(--demo-caption-columns) * 1ch); block-size: 2lh; margin-inline: auto; font: var(--docs-xs)/1.4 var(--type-family-product); color: var(--docs-quiet); letter-spacing: 0; text-align: left; white-space: pre; }
  .carousel-dots { display: flex; justify-content: center; align-items: center; gap: .125rem; min-height: 24px; }
  .carousel-dots button { display: grid; place-items: center; min-width: 24px; height: 24px; padding: 0 4px; border: 0; border-radius: var(--radius-small); background: transparent; cursor: pointer; }
  .carousel-dots button::after { content: ''; display: block; width: 4px; height: 4px; border-radius: 999px; background: var(--rp-muted); transition: width var(--motion-feedback) var(--easing-standard), background var(--motion-feedback) var(--easing-standard); }
  .carousel-dots button.active::after { width: 20px; background: var(--docs-quiet); }
  .carousel-dots button:hover::after { background: var(--rp-iris); }
  button.active .situation-title { color: var(--rp-text); }
  .progress { position: absolute; inset: auto 0 0; height: 3px; background: var(--rp-muted); }
  .progress::after { content: ''; display: block; height: 100%; width: 0; background: var(--rp-love); }
  button.playing .progress::after { animation: progress 1s linear both; }
  button.played .progress::after { width: 100%; }
  button.resetting :global(.pane) { transition: none; }
  .demo-error { margin: .6rem; color: var(--rp-love); font-size: var(--docs-sm); }
  @keyframes progress { to { width: 100%; } }
  @media (prefers-color-scheme: light) { .demo-stage { --demo-raised: var(--rp-surface); --demo-sunken: var(--rp-overlay); } }
  @media (prefers-reduced-motion: reduce) { .carousel-dots button::after, .scroller::before, .scroller::after { transition: none; } button.playing .progress::after { animation: none; width: 100%; } }
</style>
