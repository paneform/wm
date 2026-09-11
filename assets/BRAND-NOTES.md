# Paneform identity system

## Concept

The shared mark is a **formed pane**: a subtly rounded app window capped by a flush top-edge bar with a hard lower cut, above one broad primary pane and two stacked secondary panes. The pane field has a consistent six-unit margin beneath the cap and along the left, right, and bottom edges. Tight two-unit internal gutters keep the layout feeling like one managed desktop rather than a collection of floating tiles.

The suite mark is neutral. Product marks preserve the same 64×64 canvas, 8-unit outer radius, 2-unit pane gutters, 5-unit pane radius, and dark shell. Only the inner accent changes:

- **WM:** the active upper-right pane is mint.
- **Bar:** a mint status strip caps a modular layout.
- **Relay:** one direct signal link physically joins two broad stacked endpoint windows.

## Palette model

The marks are defined by semantic roles from the standard 16-color terminal palette, not fixed brand colors:

- Shell — `--ansi-black`
- WM dark panes — `--ansi-bright-black`
- WM dark product signal — `--ansi-green`
- Light-mode panes and primary lettering — `--ansi-white`
- Light-mode product signal — `--ansi-cyan`
- Secondary lettering — `--ansi-bright-black`

Every SVG uses CSS custom properties with Rosé Pine ANSI colors as portable fallbacks. Rosé Pine Main is the dark-mode default, and a `prefers-color-scheme: light` query switches the fallback palette to Rosé Pine Dawn. For example:

```svg
fill="var(--ansi-black, var(--pf-black))"
fill="var(--ansi-white, var(--pf-white))"
fill="var(--ansi-cyan, var(--pf-cyan))"
```

This makes the default edition responsive to Rosé Pine Main/Dawn while keeping the identity palette-independent. A host can set the `--ansi-*` properties on an inline SVG to inherit any terminal theme; those host values take precedence over both built-in modes.

The complete Rosé Pine ANSI reference is:

| ANSI role | Normal | Bright |
| --- | --- | --- |
| Black | `#26233a` | `#6e6a86` |
| Red | `#eb6f92` | `#eb6f92` |
| Green | `#31748f` | `#31748f` |
| Yellow | `#f6c177` | `#f6c177` |
| Blue | `#9ccfd8` | `#9ccfd8` |
| Magenta | `#c4a7e7` | `#c4a7e7` |
| Cyan | `#ebbcba` | `#ebbcba` |
| White | `#e0def4` | `#e0def4` |

The Rosé Pine Dawn roles used by the logo are ANSI black `#f2e9e1`, bright black `#9893a5`, cyan `#d7827e`, and white `#575279`.

For Paneform WM in Rosé Pine Main, ANSI bright black/Muted colors the structural panes and ANSI cyan/Rose identifies the active pane. The Dawn mapping remains the darker foreground with Rose active treatment.

The signal color is functional rather than decorative: it always identifies the product's active behavior.

## Usage

- Use the product mark for app icons, repositories, favicons, and social avatars.
- Use the horizontal lockup when the product name must be explicit.
- At 16–24 px, use the mark unchanged; its 4-unit gutters remain legible.
- Do not assign arbitrary per-product hues. Future products should earn one distinct internal gesture while retaining the shared ANSI roles and frame.
- For monochrome contexts, use the suite mark and map ANSI black/white to the available foreground/background pair.

The lockup uses lowercase **Inter SemiBold** (weight 650) for “paneform” and lowercase **Inter Medium** (weight 500) for the product suffix. Both are set at 68 units on a shared baseline at y=54. The lowercase bodies align with the icon's straight-sided region, the `p` descender reaches toward the icon bottom, and the `f` ascender rises toward its top. Primary lettering uses ANSI white because terminal palettes conventionally map that slot to readable foreground text in both dark and light modes; the icon shell uses ANSI black. Its system-sans fallback stack is included for portability. Convert the lettering to outlines for production exports when exact rendering across machines matters.
