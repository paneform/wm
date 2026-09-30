# Docs experience design

The plan for a documentation surface where every state-changing command is
demonstrated live, command descriptions are generated from code, and prose is
reserved for what code cannot express.

Status: design phase. Nothing here is implemented yet. This document is the
agreement on layout, information architecture, and data flow before code
changes begin.

## Goals

1. Docs feel alive. Reading a command page should feel like a guided demo:
   a screen, a few windows, one focused window, one button that shows what
   the command does.
2. No drift between code and docs. A command's description, syntax, and
   behavior notes live next to the command definition. Config options
   follow the same pattern.
3. Every invocation method is presented consistently: CLI, keybind, and
   WebSocket payload appear together in one table on every command page.
4. Demos are simple: one display, at most four windows, one focused window,
   one command. Scenario JSON is committed; share links are generated
   dynamically and never stored.
5. Markdown remains the tool for installation, setup, and conceptual
   writing that does not map to code.

## Principles

- **Show, then tell.** The demo appears before the prose explanation.
- **One screen, one idea.** Each demo isolates one behavior. Where a command
  behaves differently depending on context, the page shows one demo per
  context, labeled with that context ("at the edge", "neighbor shares the
  edge", "interior").
- **Generated, not transcribed.** If code can produce the text, code
  produces the text. Authors write intent, not syntax.
- **The playground is the deep end.** Demos link into `/wm/play` with the
  scenario preloaded, so curiosity has an escape hatch into the full
  editor.

## Information architecture

All docs live under `/wm/docs/` on the existing SvelteKit site.

```
/wm/docs/                          Overview + 60-second tour (one live demo)
/wm/docs/getting-started/          Markdown: install, permissions, service, first config
/wm/docs/concepts/                 Markdown: workspaces, layout modes, pause, state model
/wm/docs/commands/                 Generated index, grouped by domain
  /wm/docs/commands/windows/…      focus-directional, move-directional, move-to-workspace,
                                   move-to-point, resize, float, tile, manage, unmanage,
                                   probe-limits
  /wm/docs/commands/workspaces/…   focus, move-to-next-display, move-to-display, mode, retile
  /wm/docs/commands/system/…       pause, resume, reconcile, reload-config, validate-config,
                                   state/windows/displays/workspaces queries
  /wm/docs/commands/service/…      install, start, stop, restart, status, uninstall
  /wm/docs/commands/diagnostics/…  doctor, permissions-request
/wm/docs/configuration/            Generated from config schema + authored keybinds guide
/wm/docs/reference/                Argument types, scenario format, WebSocket protocol, CLI listing
```

Two kinds of pages:

- **Command reference pages** (generated). One page per user-facing command.
- **Guide pages** (markdown). Authored prose; may embed the same demo
  components.

Navigation: persistent left sidebar — top-level groups (Getting started,
Concepts, Commands, Configuration, Reference), with a domain subheading
level under Commands (Windows, Workspaces, System, Service, Diagnostics)
where the page count needs it — plus a right-hand "on this page" rail on
command pages and a "Related commands" block in the footer of every
command page.

The right-hand "on this page" rail follows the page's H2/H3 anchors:
H3 entries and the rail both angle inward under H2 entries, including on
authored guides. Track, progress, and active section share one connected SVG
path sized to the rendered TOC. Its progress stroke fills with document
scroll via a CSS scroll-driven animation. A short active segment slides along
the path as the current heading changes, but settles only on the straight run
beside that heading — the bend itself stays unhighlighted. That heading also
gets stronger text and `aria-current="location"`. Reduced-motion mode skips
both animations.
On narrower screens the rail is hidden. The active sidebar entry uses
background and weight, without a left accent border. In the top bar, the
Paneform WM lockup links to `/wm` and the separate docs label links to
`/wm/docs` (stacked under the lockup on mobile).

A command slug is stable and derived from the command registry (for example
`windows/move-directional`), never from the CLI spelling, because some
commands have several CLI spellings.

## Documentation typography

Use one compact size scale across generated reference pages and authored guides.
The standalone mockup defines these as `--docs-type-size-*`; the site docs shell
should scope the same tokens to its own layout so the product hero keeps its
separate type system.

| Token  | Size            | Typical use                                             |
| ------ | --------------- | ------------------------------------------------------- |
| `xs`   | 0.75rem (12px)  | Breadcrumbs, table headers, badges, small notes         |
| `sm`   | 0.875rem (14px) | Sidebar and TOC links, controls, code, tables, terminal |
| `base` | 1rem (16px)     | Guide prose, command summaries, demo introductions      |
| `lg`   | 1.25rem (20px)  | Command-page sections                                   |
| `xl`   | 1.75rem (28px)  | Page titles                                             |

Keep weight, line height, and tracking separate from size. Guide subheadings
use `base` with stronger weight; they do not need another size. Tiny labels
inside the simulated desktop use a separate `--docs-type-size-simulation`
(0.5625rem) because they depict on-screen chrome rather than docs text.

For text that should recede without becoming hard to read, use the docs ink
roles below. Derive them from the Rosé Pine palette in each color scheme:

```css
/* Dark */
--docs-text-heading: var(--rp-subtle);
--docs-text-label: color-mix(in srgb, var(--rp-subtle) 80%, var(--rp-text));
--docs-text-quiet: var(--rp-subtle);

/* Light */
--docs-text-label: color-mix(in srgb, var(--rp-subtle) 40%, var(--rp-text));
--docs-text-quiet: color-mix(in srgb, var(--rp-subtle) 60%, var(--rp-text));
```

Dark `quiet` and both themes' `heading` are exactly `--rp-subtle`, so they need
no mix. Light `--rp-subtle` has 3.67:1 contrast on the raised overlay (4.02:1
on the page), so use `heading` only for large, semibold section headings that
meet WCAG AA's 3:1 large-text threshold. Smaller guide subheadings use `quiet`.
The other roles clear 4.5:1 for normal text on the page, surface, and raised
overlay. The lowest ratio for each is:

| Token                 | Lowest contrast | Typical use                                                             |
| --------------------- | --------------- | ----------------------------------------------------------------------- |
| `--docs-text-heading` | 3.67:1          | Large section headings only; `--rp-subtle`                              |
| `--docs-text-label`   | 5.75:1          | Table headers, nav group labels, section markers                        |
| `--docs-text-quiet`   | 4.71:1          | Small guide subheadings, breadcrumbs, notes, asides, secondary metadata |

Use these roles for small text instead of raw `--rp-muted`, which falls below
4.5:1 in both themes. Reserve stronger theme accents for emphasis where needed,
rather than coloring every label.

## Command page anatomy

Fixed section order on every command page — the demo leads, because a
clear demo is the fastest path from zero to understanding:

1. **See it work.** The human title and one-sentence registry summary
   open the page. A labeled concrete command example precedes one large
   stage headed by a situation index (one preview and short name per demo).
2. **Invocation.** One row per method, always in the same order.
   Cells always show argument placeholders; concrete values appear in the
   labeled demo example:

   | Method        | Invocation                                              |
   | ------------- | ------------------------------------------------------- |
   | CLI           | `wm window move <direction>`                            |
   | Keybind       | `"option+h": "window move <direction>"` (in `keybinds`) |
   | WebSocket     | `{"type":"moveDirection","direction":"<direction>"}`    |
   | Scenario step | `"window move <direction>"`                             |

   Rows are omitted when a method does not apply (for example `doctor` has
   no WebSocket row because it runs locally and never contacts the daemon).
   The move-to-workspace page shows both focused-window spellings
   (`window move workspace <workspace>` and `workspace move-window <workspace>`)
   and the distinct explicit-ID form
   (`workspace move-window <window-id> <workspace>`), with a concrete example
   using an ID from `wm windows`. The focused form follows the window; the
   explicit-ID form does not switch the view. Chords render as key caps where
   space allows. Beneath the syntax, each applicable method
   has a short note with a link. Keybind, WebSocket, and Scenario notes come
   from one shared method-help definition, not from each command's registry
   entry:

   | Method    | Shared note                                                  | Link               |
   | --------- | ------------------------------------------------------------ | ------------------ |
   | Keybind   | Assign a shortcut to a concrete command in your config.      | Keybinds guide     |
   | WebSocket | Send a command payload to the local service.                 | WebSocket protocol |
   | Scenario  | Use this command in a playground or docs demo, or in a test. | Scenario format    |

   Command-specific notes may accompany the shared note where helpful (for
   example, directional commands need one chord per direction). The mockup
   repeats the shared text in its two static pages; the generated renderer
   should supply it once from method metadata.

3. **Arguments.** Slot table (name, semantic type, usage/allowed values)
   generated from the command path tokens, directly under the invocation so
   syntax and its parameters read together. Type names link to a shared
   argument-types reference; optionality belongs to a specific command form,
   not to the type. Enum values are listed as text; open-ended workspace
   names are described as such, not presented as a fixed list.
4. **Errors.** A three-column table — code, meaning, what to do —
   directly after the invocation and arguments so the "how" and its
   failure modes read together. Codes come from the engine's closed error
   union (`CommandErrorCode`); the drift-guard test asserts every listed
   code exists there and carries a meaning and an action.
5. **Related.** Links to sibling commands and the governing concept page.

Behavior prose has no standalone section: each demo's claim states its
behavior (see "Stage and situations"), and shared invariants (for
example "operates on the focused window") live in the demo section's
intro sentence.

## Demo system

### Kinds

- **Desktop demo** — scenario-backed, rendered by the existing
  `layout-browser` desktop simulator. Covers every command that changes
  window-manager state.
- **Terminal demo** — a scripted, animated terminal replay for local
  commands whose output is text (for example `wm doctor`). The scenario
  format does not apply; the script is a small JSON of typed lines with
  timing. Output renders pretty-printed (stable indentation, one property
  per line) on the page background rather than a dark console theme.

### Desktop demo card anatomy

```
┌──────────────────────────────────────┐
│ ┌──────────────────────────────────┐ │
│ │ workspace bar (playground UI)    │ │   ← bare display rectangle (the playground stage)
│ │ ┌────────┐                       │ │
│ │ │ Mail   │  ┌─────────┐          │ │
│ │ └────────┘  │ Editor ←│ focused │ │
│ │             └─────────┘          │ │
│ └──────────────────────────────────┘ │
│ "Editor sits to the right of Mail."  │   ← step-title line (playground player bar)
│ ▶ ─●──── 1                       ↗   │   ← transport + playground link
└──────────────────────────────────────┘
```

The card chrome is the playground's own player bar, not bespoke demo
controls:

- The **step-title line** (the playground's aria-live caption) shows the
  situation before running and the scenario step's `caption` after.
  Hovering a rail pip previews its text, exactly as in the playground.
- The **transport control** plays the scenario's single step through the
  real runner. While playing it offers pause; when the step completes it
  becomes Return-to-start, which restores the initial session snapshot.
  Reset is the same control, as in the playground — there is no separate
  reset button.
- The **step rail** shows the single step as a pip (start pip + step pip)
  and fills as the step plays.
- The transport row carries one docs-specific addition:
  **Open in playground**, which encodes the scenario with
  `encodeScenarioFragment` at click time and opens
  `/wm/play#scenario=gz.…. Links are computed, never committed. The
  concrete command is labeled once above the stage, so each demo needs no
  command chip.
- Bound chords appear in the Invocation table alongside the command syntax.
- Demos never autoplay; every demo waits for an explicit Run. Motion only
  happens on command, which also keeps the docs calm to re-read.
- `prefers-reduced-motion` skips animation and jumps to the result.

### Reuse over reinvention

The demo screen is the playground's own stage, not a second renderer:

- The window system runs through `createScenarioSession`
  (`@paneform/layout-browser`) — the same headless, deterministic runner
  the playground uses. Run executes the scenario's step; Reset restores
  the session snapshot taken at load.
- The visible surface is the playground's screen assembly (`WindowSurface`
  windows, `DesktopTopBar` workspace bar) wrapped in `DesktopDisplay` with
  its new `stand` option (default `true`; `stand={false}` renders the bare
  display rectangle — same bezel, no monitor stand or feet). Demos embed
  it stand-less: no laptop lid, no stand, and no dock. The dock and top
  bar are gated by the scenario's own `presentation` flags
  (`showDock: false`, `showTopBar: true`); the workspace bar stays because
  it shows which workspace is focused and which windows live where,
  updating live as windows move.
- The only demo-specific code is the card chrome around the stage:
  situation label, Run/Reset buttons, caption, and the playground link.

### Scenario authoring rules

Demos are ordinary `LayoutScenario` documents (validated against
`scenario.schema.json`, checked by a vitest parse test like the hero
scenario). To keep them simple:

- exactly one playable `command` step, with `caption` and `expect`;
- preparation is an ordered prefix of `steps[]`. The demonstrated step is
  marked `"playback": "start"`; the runner executes and validates earlier
  steps before presenting the initial snapshot. Without a marker, playback
  starts at the first step;
- initial states are structural sketches (clean halves and quadrants, no
  hardcoded spacing). A preparation `reconcile` step, with its own `expect`,
  lets the engine itself refit the initial geometry to the
  config — gap, margins, and any future layout setting propagate to
  every demo by editing config, never by re-authoring scenarios;
- tests run each complete scenario and rely on its preparation and playback
  expectations. Exact frame assertions currently use logical points and must
  be reviewed when gap or margin configuration changes;
- interaction is off: docs demo scenarios set
  `presentation.interactive: false` so the stage renders read-only
  playback (no drag, resize, close, focus, or dock activation) — the
  Run button is the only control the reader needs. The playground and
  `/wm` hero keep the flag at its default (interactive);
- one display unless the command is display-related;
- at most four windows; `presentation` hides the dock and keyboard and
  sets `interactive: false` for read-only playback.

Files live at
`apps/site/src/lib/docs/demos/<command-slug>/<demo-slug>.json` and are
imported at build time. A registry entry names its demo files; a test
fails if a referenced file is missing or a file is unreferenced (no orphans,
no dead links).

### Multiple demos per command: a compact snapping carousel

Demos share one horizontally scrollable stage, keeping a consistent footprint
for one through five examples:

- Each demo represents one **situation**, with a miniature layout preview,
  short name and semantic starting/result caption. Cards stay 240px high
  and use a fixed width derived from the caption width plus padding (about
  254px). A single example uses the same width instead of stretching.
  Subtle sunken/raised card surfaces and each item's player progress bar
  follow the reference. The outer carousel stays unframed, with tightly
  spaced cards and a row of pips; the active example has a wider pip.
  No footer toolbar is shown.
- Starting and result captions use a fixed **32ch, two-line monospace** area.
  A shared docs-only rule caps text at **64 characters** and checks that its
  words fit two 32-column lines. Rendering uses explicit word-boundary wraps
  rather than clipping or truncation; the same width drives CSS and validation.
- The carousel uses native horizontal scrolling and CSS scroll snapping.
  Mobile keeps the same single row, with a partial neighboring card signaling
  that more examples are available.
- Every name remains visible and searchable whether its demo is active or
  not. The active demo's step title explains its starting state and the
  result after Run. Shared behavior lives in the section's intro sentence.
- Autoplay brings the active card into view without scrolling the document.
  It holds the starting state for one second before animation; clicking a
  card or using navigation starts that example without the autoplay hold.
- Cards, dots, keyboard arrows and Home/End provide manual navigation.
  Horizontal browsing pauses automatic advancement; the snapped card becomes
  the selected example. Pips always select and play, including the current
  example. Escape pauses autoplay; selecting an example resumes it.
- Hover and focus do not stop autoplay. Automatic advancement suspends while
  browsing horizontally, while offscreen, or while the page is hidden.
  Reduced motion disables
  autoplay by default and uses instant scrolling and window updates.
- Only the active card owns a scenario session; other previews use their
  saved snapshots, keeping cost bounded as more examples are added.
- Where context changes behavior, one demo per context:

`window move left` demonstrates:

| Situation                                            | What the reader sees                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------------------- |
| Neighbor in the direction                            | The two windows swap positions.                                            |
| At the display edge, another window shares that edge | The moved window rotates around the tree and expands along the whole edge. |
| At the display edge, alone                           | Nothing moves; the command is a no-op.                                     |

Directional siblings (right/up/down) note "same behavior in the other
direction" rather than repeating twelve scenarios.

### Command variables and demo examples

- **Reference syntax stays stable.** Invocation cells use `<direction>` or
  `<workspace>` for variable slots across CLI, keybind, WebSocket, and
  scenario forms. The Arguments table lists the four directions and explains
  that workspace names are open-ended; neither is an interactive control.
- **One example command per stage.** Plain text above the directional stage
  says `Example command: wm window move left`; the workspace stage shows
  `wm window move workspace writing`. Every situation on a stage runs that
  same real command against a different starting state. The command is
  visible before playback without becoming a second tab strip or player
  control. Demos illustrate behavior; readers can explore other values in
  the playground. Right/up/down share left's behavior in other directions.
- **Scenarios are fixed examples.** Committed demo scenarios use concrete
  values and captions; there is no page-wide parameter state, geometry
  rotation, or page-text rewriting. The playground link encodes the
  selected situation's concrete scenario at click time.
- **Chrome clearance remains engine-level.** Each demo sets
  `config.defaults.margins.top` from the displayed workspace bar's height
  (rem-based, converted to logical points), so the engine tiles below it.
  The docs stage overrides `--camera-height: 1.1rem` on DesktopTopBar and
  uses the fixed `--window-titlebar-height` token for small windows.
- **Situation selection uses the URL query** (`?demo=edge-expand`, written
  with `replaceState`) to reproduce the view. The hash remains available
  for section anchors; the bare URL is canonical. Capture the initial query
  before changing selection so a linked situation is not overwritten.

## Source of truth in code

### Command registry

A new `command-docs.ts` sits beside `commands.ts` and `command-syntax.ts` in
`packages/layout/src/`. Every engine command type gets one entry:

```ts
export const commandDocs = {
  moveDirection: {
    slug: "windows/move-directional",
    title: "Move window directionally",
    summary: "Swap the focused window with its neighbor in a direction.",
    behavior: [
      "Swaps positions when a neighbor exists in the direction.",
      "At the display edge, expands along that edge when another window shares it.",
      "Does nothing when the focused window is alone at the edge.",
    ],
    errors: [
      { code: "window_not_found", meaning: "No live window matches the target.", action: "List live windows with wm windows and retry." },
      { code: "paused", meaning: "The manager is paused and holds mutations.", action: "Resume with wm resume, then retry." },
    ],
    related: ["focusDirection", "moveFocusedWindowToWorkspace"],
    demos: [
      { slug: "interior-swap", tab: "Neighbor swap", claim: "The two windows swap positions." },
      { slug: "edge-expand", tab: "Edge expand", claim: "The moved window rotates around the tree and claims the full edge." },
      { slug: "edge-alone", tab: "Alone at the edge", claim: "Alone at the edge → nothing changes; a no-op is success, not an error." },
    ],
  };
  // …one entry per command type
} as const satisfies Record<Command["type"], CommandDoc>;
```

Allowed values come from the grammar's own slot vocabulary (the
`DIRECTIONS` list in `command-syntax.ts`), so the Arguments table and the
real parser can never disagree about what a slot accepts.

- CLI spellings, tokens, and slot metadata stay in `command-syntax.ts`
  (they are grammar, not docs). `commandPaths` entries gain a
  `commandType` field naming the engine command they build, so the docs
  generator can join grammar to registry.
- A drift-guard test asserts: every `commandPaths` entry names a registry
  slug, every registry slug has at least one grammar path, every demo
  file referenced exists, and every registry error code is a member of
  the engine's `CommandErrorCode` union. Docs cannot fall behind code
  silently.
- The full CLI listing, the commands index, and `wm --help`-style output
  all render from the same two files.

The move-to-workspace page groups two related engine command types:
`moveFocusedWindowToWorkspace` (the two focused CLI spellings) and
`moveWindowToWorkspace` (the explicit-ID form). They share a user-facing page,
but must keep their distinct syntax and follow-focus behavior in the registry
and drift checks; a CLI alias is not the same as an optional argument.

### Argument type reference

Add a compact `/wm/docs/reference/argument-types/` page, with stable anchors
for recurring semantic types rather than one page per argument occurrence:

| Type                              | Shared definition should explain                                                                                                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window ID                         | Obtain a current ID from `wm windows`; live commands target that ID, not a window title. Scenario files can also use their own window names/IDs. An unknown live ID yields `window_not_found`. |
| Workspace name                    | A name supplied as one argument (quote names containing spaces); whether a missing workspace is created or rejected depends on the command.                                                    |
| Direction                         | Closed set `left`, `right`, `up`, `down`.                                                                                                                                                      |
| Display ID, coordinate, dimension | ID source, coordinate space and units, and numeric constraints, respectively.                                                                                                                  |

Keep **type-level** definitions and examples in this reference; show
**command-level** rules on each command page (required in this form, defaults
to focused in that form, creates a missing workspace here). Distinguish
CLI token/shape validation, transport schema validation, and runtime lookup:
the parser's slot checks, `Command` schema, and engine checks do not all make
the same promises. The existing `command-syntax.ts` slot kinds and descriptions
provide the starting vocabulary; extend that metadata with stable type IDs
and documentation links rather than hardcoding `slot` or `name` as public
type labels. Use those IDs to link Arguments tables and contextual CLI help
to the same reference.

### Config options (investigated)

Config is a strict Effect Schema in `packages/layout/src/config.ts`, and the
scenario JSON Schema is already generated from Effect Schema annotations by
`generate-scenario-schema.ts`. The same mechanism works for docs:

- Attach `description` (and `title` where useful) annotations to each field
  of `ConfigSchema`, `defaults`, display/workspace overrides, and
  `experiments` — the description lives in the code beside the option.
- Add a small generator that emits JSON Schema with those descriptions for
  a docs renderer; the keybinds chord grammar gets a hand-written syntax
  page (the Swift parser is the authority for key names).
- Result: `wm validate-config` messages, editor schema validation, and the
  configuration docs page all read one description per option. Feasible
  with the existing tooling; no new dependencies.

### Terminal demos

`doctor` output is produced by the Swift sidecar as JSON. Its demo script is
a committed JSON of output lines with annotations (what to look for:
permission states, sidecar version), rendered by a typing/reveal animation.
The sample output is marked as illustrative in small print until a fixture
can be generated from a real run.

## Markdown authoring

Guide pages use mdsvex (markdown that compiles to Svelte components) on the
SvelteKit site, with Shiki for highlighting. Demo cards are imported
components, so a concept page can embed the same live demo a command page
uses. Code fences in guides can be checked against the real grammar in a
test (`buildCommand` round-trip) to prevent invalid examples.

## Representative pages

Three pages nail the design before broad coverage:

1. **`windows/move-directional`** — three desktop demos (swap, edge
   expand, edge no-op), full invocation table, argument table for
   `direction`.
2. **`windows/move-to-workspace`** — two desktop demos: move the focused
   window to an empty workspace (view follows), and move into a populated
   workspace (target retiles around the insertion). Table shows the two
   focused spellings and the explicit-window variant with an ID example.
3. **`diagnostics/doctor`** — terminal demo kind, CLI-only invocation
   table, exit-code table, links to the permissions guide.

## Open questions

1. **Playground gating.** `requirePlayground` currently 404s the playground
   in production. Demo links need either the gate lifted (preferred: the
   playground is read-only-safe) or a lighter `/wm/play/embed` viewer.
2. **CSP.** The site uses a strict hash-based CSP; demo components must be
   Svelte components with no inline handlers (consistent with existing
   code).
3. **Worker vs main thread.** Resolved for docs-scale demos: the design
   mockup runs sessions on the main thread (one-step scenarios create
   fast, step instantly) with session-per-demo and scenario-key
   deduplication; revisit workers only if pages accumulate many
   concurrent demos.
4. **Grouped command types.** Focused and explicit-ID workspace moves map to
   different engine command types on one user-facing page. The registry and
   drift checks need to group both types under that page without treating
   the explicit-ID path as another alias of the focused command.

## Implementation sequence (future beans)

1. Registry + `commandType` joins + drift-guard tests.
2. Docs shell: layout, sidebar, TOC, mdsvex pipeline.
3. Demo card component + demo JSONs for the three representative pages.
4. Config annotations + generated configuration page.
5. Remaining commands: fill registry entries, author scenarios.
