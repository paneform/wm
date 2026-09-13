export const waitlistEndpoint =
  "https://app.loops.so/api/newsletter-form/cmtyx917h28bf0jygmf7i7w3v";
export const waitlistGroup = "pre-launch";
export const waitlistMailingList = "cmu08ntus3w6u0j1m8mnz0tim";

export async function joinWaitlist(email: string): Promise<void> {
  const response = await fetch(waitlistEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email: email.trim(),
      userGroup: waitlistGroup,
      mailingLists: waitlistMailingList,
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });

  if (response.status === 429) {
    throw new Error("Too many signup attempts. Please wait a minute and try again.");
  }

  const result = await response.json();
  if (!response.ok || result?.success !== true) {
    throw new Error("We couldn’t save your email. Please try again.");
  }
}
