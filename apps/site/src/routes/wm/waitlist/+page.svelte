<script lang="ts">
  import WaitlistPage from "$lib/hero/WaitlistPage.svelte";
  function interact() {
    if (window.parent !== window) window.parent.postMessage({ type: "wm-waitlist-interaction" }, window.location.origin);
  }
</script>

<svelte:head>
  <title>Join the paneform wm waitlist</title>
  <meta name="description" content="Join the waitlist for paneform wm, the tiling window manager that just works." />
  <link rel="canonical" href="https://paneform.com/wm/waitlist" />
</svelte:head>
<svelte:window onpointerdown={interact} onfocusin={interact} onkeydown={interact} />
<WaitlistPage />
