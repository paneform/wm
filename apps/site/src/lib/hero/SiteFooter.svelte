<script lang="ts">
  import type { Snippet } from "svelte";
  import WaitlistForm from "./WaitlistForm.svelte";

  let { onfocusin, failureStatus }: { onfocusin?: () => void; failureStatus?: Snippet } = $props();
</script>

<footer id="waitlist-signup" {onfocusin}>
  <div class="footer-info">
    <p>Your desktop, organized. Coming first to Mac.</p>
    <p class="creator-credit">Crafted with care by <a href="https://allandeutsch.com">Allan Deutsch</a> <a class="bluesky-link" href="https://bsky.app/profile/allandeutsch.com" aria-label="Allan Deutsch on Bluesky">🦋</a></p>
    {#if failureStatus}{@render failureStatus()}{/if}
  </div>
  <div class="footer-form"><WaitlistForm compact /></div>
</footer>

<style>
  footer { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); align-items: center; gap: 0.75rem 2rem; padding: 0.75rem var(--page-gutter); border-top: 1px solid var(--color-line-default); color: var(--color-page-quiet); font: var(--type-size-label)/1.5 var(--type-family-product); }
  p { margin: 0; }
  .footer-info { min-width: 0; }
  .footer-form { width: 100%; max-width: 26rem; min-width: 0; justify-self: end; }
  .creator-credit { display: flex; align-items: center; flex-wrap: wrap; gap: 0.35em; }
  a { color: inherit; text-underline-offset: 0.2em; }
  a:hover { color: var(--color-page-foreground); }
  a:focus-visible { outline: 2px solid var(--color-focus-ring); outline-offset: 3px; }
  .bluesky-link { display: inline-flex; align-items: center; justify-content: center; min-width: 1.5rem; min-height: 1.5rem; text-decoration: none; }
  @media (max-width: 42rem) {
    footer { grid-template-columns: minmax(0, 1fr); justify-items: center; text-align: center; }
    .footer-form { grid-row: 1; justify-self: center; }
    .creator-credit { justify-content: center; }
  }
</style>
