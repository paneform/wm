import { commandDocs, hostCommandPaths, type DocumentedCommand } from "@paneform/layout";

export const docsBase = "/wm/docs";
export const commandHref = (slug: string) => `${docsBase}/commands/${slug}/`;

export interface CommandNavNode {
  token: string;
  label: string;
  href?: string;
  syntax?: string;
  summary?: string;
  keywords?: string;
  children: CommandNavNode[];
}
interface CommandNavEntry {
  path: readonly string[];
  href: string;
  syntax: string;
  summary: string;
  keywords?: string;
}
const labelFor = (word: string) => word[0]!.toUpperCase() + word.slice(1);

function literalPrefix(syntax: string): string[] {
  const words = syntax.replace(/^wm\s+/, "").split(/\s+/);
  const end = words.findIndex(
    (word) => word.startsWith("--") || word.includes("<") || word.startsWith("["),
  );
  return end === -1 ? words : words.slice(0, end);
}
export function commandNavigationPath(doc: DocumentedCommand): string[] {
  const prefixes = doc.forms.map((form) => literalPrefix(form.syntax));
  const first = prefixes[0] ?? [];
  const difference = first.findIndex(
    (word, index) => !prefixes.every((prefix) => prefix[index] === word),
  );
  const common = difference === -1 ? first : first.slice(0, difference);
  return doc.slug.endsWith("-directional") ? [...common, "direction"] : common;
}
export const commandBreadcrumbs = (doc: DocumentedCommand): string[] =>
  commandNavigationPath(doc).map(labelFor);

function insertCommand(nodes: CommandNavNode[], entry: CommandNavEntry): void {
  let siblings = nodes;
  for (const [index, token] of entry.path.entries()) {
    let node = siblings.find((candidate) => candidate.token === token);
    if (!node) {
      node = { token, label: labelFor(token), children: [] };
      siblings.push(node);
    }
    if (index === entry.path.length - 1) {
      node.href = entry.href;
      node.syntax ??= entry.syntax;
      node.summary ??= entry.summary;
      node.keywords = [node.keywords, entry.keywords ?? entry.syntax].filter(Boolean).join(" ");
    }
    siblings = node.children;
  }
}
function hostEntries(): CommandNavEntry[] {
  return hostCommandPaths.map((path) => {
    const syntax = `wm ${path.tokens.map((token) => (token.kind === "literal" ? token.value : `<${token.label.toLowerCase()}>`)).join(" ")}`;
    const words = literalPrefix(syntax);
    if (words[0] !== "permissions" && words[0] !== "serve")
      throw new Error(`Missing documentation destination for ${words[0]}`);
    const href =
      words[0] === "permissions"
        ? commandHref("diagnostics/permissions") + (words[1] === "request" ? "#request" : "")
        : `${docsBase}/reference/cli/#serve`;
    return { path: words, href, syntax, summary: path.description ?? "Host command" };
  });
}
function sortCommandNavigation(nodes: CommandNavNode[]): CommandNavNode[] {
  nodes.sort((left, right) => left.label.localeCompare(right.label, "en"));
  for (const node of nodes) sortCommandNavigation(node.children);
  return nodes;
}
function buildCommandNavigation(): CommandNavNode[] {
  const nodes: CommandNavNode[] = [];
  for (const doc of commandDocs)
    insertCommand(nodes, {
      path: commandNavigationPath(doc),
      href: commandHref(doc.slug),
      syntax: doc.forms[0]!.syntax,
      summary: doc.summary,
      keywords: [doc.title, ...doc.forms.map((form) => form.syntax)].join(" "),
    });
  for (const entry of hostEntries()) insertCommand(nodes, entry);
  return sortCommandNavigation(nodes);
}
export const commandNavigation = buildCommandNavigation();
export function isCommandNavActive(node: CommandNavNode, currentHref: string): boolean {
  if (node.href === currentHref) return true;
  return (
    node.href === currentHref.split("#")[0] &&
    !node.children.some((child) => child.href === currentHref)
  );
}
export const guideLinks = [
  { title: "Installation", href: `${docsBase}/getting-started/` },
  { title: "Workspaces and layout", href: `${docsBase}/concepts/` },
  { title: "Configuration", href: `${docsBase}/configuration/` },
  { title: "CLI listing", href: `${docsBase}/reference/cli/` },
] as const;
function commandSearchEntries(
  nodes: readonly CommandNavNode[],
  ancestors: readonly string[] = [],
): DocsSearchEntry[] {
  return nodes.flatMap((node) => {
    const path = [...ancestors, node.label];
    const own = node.href
      ? [
          {
            title: path.join(" "),
            href: node.href,
            summary: node.summary ?? "Command",
            keywords: node.keywords ?? node.syntax ?? "",
          },
        ]
      : [];
    return [...own, ...commandSearchEntries(node.children, path)];
  });
}
interface DocsSearchEntry {
  title: string;
  href: string;
  summary: string;
  keywords?: string;
}
export const searchEntries: readonly DocsSearchEntry[] = [
  { title: "Documentation overview", href: `${docsBase}/`, summary: "Start here" },
  ...guideLinks.map((link) => ({ ...link, summary: "Guide" })),
  ...commandSearchEntries(commandNavigation),
];
