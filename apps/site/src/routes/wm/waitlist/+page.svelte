<script lang="ts">
  import WaitlistPage from "$lib/hero/WaitlistPage.svelte";
  import SocialMetadata from "$lib/hero/SocialMetadata.svelte";
  function interact() {
    if (window.parent !== window) window.parent.postMessage({ type: "wm-waitlist-interaction" }, window.location.origin);
  }
</script>

<SocialMetadata
  title="Join the Paneform WM waitlist"
  description="Join the waitlist for Paneform WM, a reliability-first tiling window manager for macOS."
  canonical="https://paneform.com/wm/waitlist/"
/>
<svelte:window onpointerdown={interact} onfocusin={interact} onkeydown={interact} />
<WaitlistPage />
