const publicUrlNames = ["PUBLIC_WAITLIST_URL", "PUBLIC_PRIVACY_URL"] as const;

type PublicUrlName = (typeof publicUrlNames)[number];
type PublicUrlEnvironment = Partial<Record<PublicUrlName, string>>;

export function validatePublicUrls(environment: PublicUrlEnvironment): void {
  for (const name of publicUrlNames) {
    const value = environment[name];

    if (value === undefined || value.length === 0) {
      throw new Error(`${name} must be set to an absolute HTTPS URL`);
    }

    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${name} must be set to an absolute HTTPS URL`);
    }

    if (url.protocol !== "https:" || url.origin === "null") {
      throw new Error(`${name} must be set to an absolute HTTPS URL`);
    }
  }
}
