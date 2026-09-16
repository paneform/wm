<script lang="ts">
  import { joinWaitlist, waitlistEndpoint, waitlistGroup, waitlistMailingList } from "./waitlist.js";

  let { compact = false }: { compact?: boolean } = $props();
  let email = $state("");
  let pending = $state(false);
  let submitted = $state(false);
  let error = $state("");

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (pending || submitted) return;
    pending = true;
    error = "";
    try {
      await joinWaitlist(email);
      submitted = true;
    } catch (cause) {
      error = cause instanceof Error && cause.message.startsWith("Too many")
        ? cause.message
        : "We couldn’t save your email. Please try again.";
    } finally {
      pending = false;
    }
  }
</script>

<div class="waitlist" class:compact>
  <form action={waitlistEndpoint} method="post" onsubmit={submit} aria-busy={pending}>
    <label class:visually-hidden={compact} for="waitlist-email">Get notified when wm is ready.</label>
    <input type="hidden" name="userGroup" value={waitlistGroup} />
    <input type="hidden" name="mailingLists" value={waitlistMailingList} />
    <div class="fields">
      <input id="waitlist-email" name="email" type="email" autocomplete="email"
        placeholder="you@example.com" required bind:value={email}
        disabled={pending || submitted} aria-describedby="waitlist-status waitlist-error" />
      <button type="submit" disabled={pending || submitted}>
        {pending ? "Joining…" : submitted ? "Thanks!" : "join waitlist"}
      </button>
    </div>
  </form>
  <p id="waitlist-status" role="status">{submitted ? "Click the link in your email to confirm your spot." : ""}</p>
  <p id="waitlist-error" role="alert">{error}</p>
  {#if !compact}<p class="privacy">We won’t share your email.</p>{/if}
</div>

<style>
  .waitlist { pointer-events: auto; max-width: var(--copy-measure); margin-block: var(--space-5) var(--space-3); container: waitlist-form / inline-size; font-size: var(--type-size-control); }
  label { display: block; margin-bottom: var(--space-2); color: var(--color-page-secondary); font-size: var(--type-size-control); }
  .compact { width: 100%; margin: 0; font-size: var(--type-size-control); }
  /* 20 input characters + 13 button characters, padding, borders, and the gap. */
  @container waitlist-form (width < calc(33ch + 3rem + 4px)) {
    .fields input, .fields button { flex: 1 0 100%; width: 100%; max-width: none; }
    .fields button { padding-inline: clamp(var(--space-2), calc((100cqi - 13ch - 2px) / 2), 1rem); }
  }
  .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .fields { display: flex; flex-wrap: wrap; justify-content: center; gap: var(--space-2); }
  input, button { min-height: var(--control-target); border: var(--stroke-hairline) solid var(--color-line-default); border-radius: var(--radius-control); padding-inline: var(--space-3); font: inherit; font-size: var(--type-size-control); }
  input { flex: 1 1 20ch; width: auto; max-width: 30ch; min-width: min(100%, calc(20ch + var(--space-3) * 2 + 2px)); background: transparent; color: var(--color-page-foreground); }
  input::placeholder { color: var(--color-page-quiet); }
  /* Use spare row width for padding before requiring the controls to wrap. */
  button { flex: 0 0 auto; padding-inline: clamp(var(--space-2), calc((100cqi - 33ch - 2rem - 4px) / 2), 1rem); white-space: nowrap; background: var(--color-action-background); color: var(--color-action-foreground); font-weight: var(--type-weight-strong); cursor: pointer; }
  button:disabled { cursor: default; opacity: 0.7; }
  p { margin: 0; font-size: var(--type-size-control); line-height: var(--type-leading-body); color: var(--color-page-secondary); }
  p:not(:empty) { margin-top: var(--space-2); }
  #waitlist-error { color: var(--rp-rose); }
  .privacy { margin-top: var(--space-2); }
  input:focus-visible, button:focus-visible { outline: var(--stroke-strong) solid var(--color-focus-ring); outline-offset: var(--space-1); }
</style>
