<script lang="ts">
  import { joinWaitlist, waitlistEndpoint, waitlistGroup, waitlistMailingList } from "./waitlist.js";

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

<div class="waitlist">
  <form action={waitlistEndpoint} method="post" onsubmit={submit} aria-busy={pending}>
    <label for="waitlist-email">Get notified when wm is ready.</label>
    <input type="hidden" name="userGroup" value={waitlistGroup} />
    <input type="hidden" name="mailingLists" value={waitlistMailingList} />
    <div class="fields">
      <input id="waitlist-email" name="email" type="email" autocomplete="email"
        placeholder="you@example.com" required bind:value={email}
        disabled={pending || submitted} aria-describedby="waitlist-status waitlist-error" />
      <button type="submit" disabled={pending || submitted}>
        {pending ? "Joining…" : submitted ? "Thanks!" : "Join the waitlist"}
      </button>
    </div>
  </form>
  <p id="waitlist-status" role="status">{submitted ? "You're on the list! We'll let you know when it's your turn to experience window bliss." : ""}</p>
  <p id="waitlist-error" role="alert">{error}</p>
  <p class="privacy">We won’t share your email.</p>
</div>

<style>
  .waitlist { pointer-events: auto; max-width: var(--copy-measure); margin-block: var(--space-5) var(--space-3); }
  label { display: block; margin-bottom: var(--space-2); color: var(--color-page-secondary); font-size: var(--type-size-control); }
  .fields { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  input, button { min-height: var(--control-target); border: var(--stroke-hairline) solid var(--color-line-default); border-radius: var(--radius-control); padding-inline: var(--space-3); font: inherit; font-size: var(--type-size-control); }
  input { flex: 1 1 12rem; width: 100%; min-width: 0; background: transparent; color: var(--color-page-foreground); }
  input::placeholder { color: var(--color-page-quiet); }
  button { background: var(--color-action-background); color: var(--color-action-foreground); font-weight: var(--type-weight-strong); cursor: pointer; }
  button:disabled { cursor: default; opacity: 0.7; }
  p { margin: 0; font-size: var(--type-size-control); line-height: var(--type-leading-body); color: var(--color-page-secondary); }
  p:not(:empty) { margin-top: var(--space-2); }
  #waitlist-error { color: var(--rp-rose); }
  .privacy { margin-top: var(--space-2); }
  input:focus-visible, button:focus-visible { outline: var(--stroke-strong) solid var(--color-focus-ring); outline-offset: var(--space-1); }
</style>
