<script lang="ts">
  import WmHero from "$lib/hero/WmHero.svelte";

  let { data } = $props();
</script>

<svelte:head>
  <title>Paneform WM | Every window in its place</title>
  <meta
    name="description"
    content="A reliability-first tiling window manager for macOS. Group windows into workspaces, then move the whole workspace between displays."
  />
  <link rel="canonical" href="https://paneform.com/wm" />
</svelte:head>

<WmHero waitlistUrl={data.waitlistUrl} privacyUrl={data.privacyUrl} />
