<script lang="ts">
  import PaneformWordmark from "./PaneformWordmark.svelte";
  import WaitlistForm from "./WaitlistForm.svelte";
  const id = $props.id();
</script>

<main class="signup" aria-labelledby={`${id}-heading`}>
  <div class="wordmark"><PaneformWordmark clipId={`${id}-wordmark`} /></div>
  <h1 id={`${id}-heading`}>the window manager<br /><em>that just works</em>.</h1>
  <WaitlistForm />
</main>

<style>
  :global(html:has(.signup)), :global(body:has(.signup)) { min-width: 0; }
  .signup { display: flex; flex-direction: column; justify-content: center; min-height: 100svh; width: min(100%, 38rem); margin: auto; text-align: center; padding: clamp(1rem, 5vw, 3rem); }
  .wordmark { width: min(11rem, 70%); margin-inline: auto; }
  .wordmark :global(svg) { width: 100%; }
  h1 { margin: 1.25rem 0; font-size: clamp(1.15rem, 1rem + 1vw, 2rem); line-height: 1.3; letter-spacing: -0.045em; }
</style>
