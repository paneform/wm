import { commandDocs } from "@paneform/layout";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  commandNavigation,
  commandNavigationPath,
  commandBreadcrumbs,
  commandHref,
  isCommandNavActive,
  searchEntries,
  conceptLinks,
  guideLinks,
  type CommandNavNode,
} from "../src/lib/docs/navigation.js";

function findNode(path: readonly string[]): CommandNavNode {
  let nodes = commandNavigation;
  let found: CommandNavNode | undefined;
  for (const token of path) {
    found = nodes.find((node) => node.token === token);
    if (!found) throw new Error(`Missing command navigation: ${path.join(" ")}`);
    nodes = found.children;
  }
  if (!found) throw new Error("Empty navigation path");
  return found;
}
const flatten = (nodes: readonly CommandNavNode[]): CommandNavNode[] =>
  nodes.flatMap((node) => [node, ...flatten(node.children)]);

describe("command documentation navigation", () => {
  it("links concept guides to existing routes and exposes them in docs search", () => {
    expect(conceptLinks.some((link) => link.href === "/wm/docs/concepts/platform-behavior/")).toBe(true);
    for (const link of guideLinks) {
      const route = new URL(`../src/routes${link.href}`, import.meta.url);
      expect(["+page.svx", "+page.svelte"].some((page) => existsSync(new URL(page, route))), link.href).toBe(true);
      expect(searchEntries.some((entry) => entry.href === link.href && entry.title === link.title)).toBe(true);
    }
  });
  it("alphabetizes every level of the command navigation", () => {
    for (const siblings of [
      commandNavigation,
      ...flatten(commandNavigation).map((node) => node.children),
    ]) {
      const labels = siblings.map((node) => node.label);
      expect(labels).toEqual([...labels].sort((left, right) => left.localeCompare(right, "en")));
    }
  });
  it("uses singular CLI namespaces and concise action labels", () => {
    expect(findNode(["window"]).label).toBe("Window");
    expect(findNode(["window", "list"])).toMatchObject({
      label: "List",
      href: commandHref("windows/list"),
    });
    expect(findNode(["workspace", "list"])).toMatchObject({
      label: "List",
      href: commandHref("workspaces/list"),
    });
    expect(findNode(["display", "list"])).toMatchObject({
      label: "List",
      href: commandHref("displays/list"),
    });
    expect(commandNavigation.map((node) => node.token)).not.toContain("system");
    expect(findNode(["pause"]).href).toBe(commandHref("system/pause"));
  });
  it("preserves real nested operations and distinguishes directional pages", () => {
    expect(findNode(["window", "move", "position"]).href).toBe(
      commandHref("windows/move-position"),
    );
    expect(findNode(["window", "move", "direction"]).href).toBe(
      commandHref("windows/move-directional"),
    );
    expect(() => findNode(["window", "frame"])).toThrow("Missing command navigation");
    expect(findNode(["window", "focus"]).href).toBe(commandHref("windows/focus"));
    expect(findNode(["window", "focus", "direction"]).href).toBe(
      commandHref("windows/focus-directional"),
    );
    expect(findNode(["workspace", "move", "display"]).href).toBe(
      commandHref("workspaces/move-to-display"),
    );
    expect(findNode(["workspace", "move", "display", "next"]).href).toBe(
      commandHref("workspaces/move-to-next-display"),
    );
  });
  it("links every generated command page exactly once and excludes flags from labels", () => {
    const nodes = flatten(commandNavigation);
    for (const doc of commandDocs) {
      expect(
        nodes.filter((node) => node.href === commandHref(doc.slug)),
        doc.slug,
      ).toHaveLength(1);
      expect(findNode(commandNavigationPath(doc)).href).toBe(commandHref(doc.slug));
    }
    expect(nodes.every((node) => !node.token.includes("--") && !node.token.includes("<"))).toBe(
      true,
    );
  });
  it("provides host commands and correctly activates parent-page and anchor links", () => {
    const permissions = findNode(["permissions"]);
    const request = findNode(["permissions", "request"]);
    expect(request.href).toBe(`${permissions.href}#request`);
    expect(findNode(["serve"]).href).toBe("/wm/docs/reference/cli/#serve");
    expect(isCommandNavActive(permissions, permissions.href!)).toBe(true);
    expect(isCommandNavActive(permissions, request.href!)).toBe(false);
    expect(isCommandNavActive(request, request.href!)).toBe(true);
    expect(
      isCommandNavActive(
        findNode(["workspace", "move", "display"]),
        findNode(["workspace", "move", "display", "next"]).href!,
      ),
    ).toBe(false);
  });
  it("uses the command vocabulary for breadcrumbs and qualified search labels", () => {
    const doc = commandDocs.find((doc) => doc.slug === "windows/list")!;
    expect(commandBreadcrumbs(doc)).toEqual(["Window", "List"]);
    expect(searchEntries.find((entry) => entry.href === commandHref(doc.slug))?.title).toBe(
      "Window List",
    );
    expect(searchEntries.find((entry) => entry.title === "Permissions Request")?.href).toContain(
      "#request",
    );
    expect(
      searchEntries.find((entry) => entry.title === "Window Focus Direction")?.keywords,
    ).toContain("wm window focus up");
  });
});
