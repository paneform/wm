/** Turn every id-carrying heading inside #docs-main into a self link: the
 * heading's content is wrapped in an anchor to its own id, so the whole
 * heading is clickable and copyable as an anchor reference. Wrapping keeps
 * heading.textContent unchanged, so the TOC's rescan guard stays stable. */
export function enhanceHeadingAnchors(root: ParentNode): void {
  for (const heading of root.querySelectorAll<HTMLElement>(
    "#docs-main :is(h1, h2, h3, h4, h5, h6)[id]",
  )) {
    if (heading.firstElementChild?.classList.contains("docs-anchor") === true) continue;
    const anchor = document.createElement("a");
    anchor.className = "docs-anchor";
    anchor.href = `#${heading.id}`;
    while (heading.firstChild !== null) anchor.appendChild(heading.firstChild);
    heading.appendChild(anchor);
  }
}
