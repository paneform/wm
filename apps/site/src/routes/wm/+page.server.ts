import { PUBLIC_PRIVACY_URL, PUBLIC_WAITLIST_URL } from "$env/static/public";

import type { PageServerLoad } from "./$types.js";

export const load: PageServerLoad = () => ({
  waitlistUrl: PUBLIC_WAITLIST_URL,
  privacyUrl: PUBLIC_PRIVACY_URL,
});
