import { commandDocs } from "@paneform/layout";

export const docsBase = "/wm/docs";
export const commandGroups = ["windows", "workspaces", "system", "service"] as const;
export const commandHref = (slug: string) => `${docsBase}/commands/${slug}/`;
export const guideLinks = [
  { title: "Installation", href: `${docsBase}/getting-started/` },
  { title: "Workspaces and layout", href: `${docsBase}/concepts/` },
  { title: "Configuration", href: `${docsBase}/configuration/` },
  { title: "CLI listing", href: `${docsBase}/reference/cli/` },
] as const;
export const searchEntries = [
  { title: "Documentation overview", href: `${docsBase}/`, summary: "Start here" },
  ...guideLinks.map((link) => ({ ...link, summary: "Guide" })),
  ...commandDocs.map((doc) => ({
    title: doc.title,
    href: commandHref(doc.slug),
    summary: doc.summary,
  })),
];
