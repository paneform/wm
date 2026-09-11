# Paneform WM Hero Design Specification

Status: Proposed for review

This document specifies the interactive hero for `paneform.com/wm`. It is a
design and implementation contract, not a specification for the shared site
navigation or the rest of the product page.

## Objective

The hero must explain Paneform WM by letting a visitor operate a small, credible
window-management environment. It should feel calm, exact, and technical rather
than cinematic for its own sake.

The product promise is:

> Paneform WM keeps windows and whole workspaces predictable as the user moves
> between apps and displays.

The primary audience is a technical macOS user who understands workspaces,
keyboard shortcuts, and tiling window managers. The primary conversion is
joining the waitlist.

## Scope

This version includes:

- The `/wm` hero and waitlist call to action
- A 14-inch M-series MacBook Pro model with a camera housing
- A proportionally scaled 27-inch Studio Display model
- A real Paneform layout simulation rendered inside both displays
- A scripted demonstration paced around a 30-second baseline
- Direct dock and physical-keyboard interaction
- System-controlled Rose Pine Main and Dawn appearances
- Responsive, reduced-motion, no-JavaScript, and failure states

This version does not include:

- Shared site navigation
- Sections below the hero
- Installation instructions or documentation links
- A theme switcher or stored appearance preference
- Real application brands, screenshots, or macOS assets
- App launching as a claimed Paneform feature; the fake dock represents the
  user launching an app before Paneform manages its window
- Audio

## Experience Principles

### One dominant object

The workstation is the hero. Copy, status text, and controls support it rather
than competing with it. The closed MacBook is centered at first. The camera
reframes only when the external display enters.

### Show the product operating

Workspace labels, window focus, tiling, physical key presses, and cross-display
movement explain the product. Avoid feature-card language inside the hero.

### Technical, not ornamental

The hacker character comes from believable keyboard input, terse state labels,
precise geometry, and monospaced type. Do not add code rain, neon outlines,
dense HUD decoration, CRT scanlines, or continuous noise.

### Quiet until something changes

Idle objects do not pulse or float. Motion happens in response to startup, a
scripted action, or user input. Focus, connection, and pressed-key states are
the strongest accents.

### Exact final geometry

Paneform controls every final window frame. Presentation transitions may
interpolate between committed frames, but they must never invent a different
layout.

## Content

Use the following copy for the first visual prototype:

| Element | Copy |
| --- | --- |
| Eyebrow | `paneform / wm` |
| Heading | `Every window in its place.` |
| Description | `A reliability-first tiling window manager for macOS. Group windows into workspaces, then move the whole workspace between displays.` |
| Primary action | `Join the waitlist` |
| Support line | `Apple silicon. Current macOS.` |
| Stage instruction | `Click an app or focus the demo and use the keyboard.` |
| Pause action | `Pause demo` |
| Resume action | `Resume demo` |
| Replay action | `Replay demo` |
| Active-user status | `You're in control.` |
| Completed status | `Demo complete. Try it.` |

The CTA is an anchor to a hosted waitlist URL supplied through the build-time
`PUBLIC_WAITLIST_URL` variable. It uses same-tab navigation. A nearby `Privacy`
link uses `PUBLIC_PRIVACY_URL`. Both values must be absolute HTTPS URLs, and the
production build must fail when either is missing or invalid. The static site
must not depend on a SvelteKit server action or client-side form submission.

The final logo is not yet available. Until it is, use the lowercase text lockup
`paneform wm` in a tokenized `5:1` logo slot. A production SVG must use the
generated logo view box, `currentColor`, and no embedded style or opaque
background. A different source aspect ratio is fitted inside the slot rather
than changing its layout. The signal animation targets the slot wrapper, so the
asset can change without new keyframes.

## Semantic Structure

The rendered order is:

1. A `main` element containing one labelled hero `section`
2. The eyebrow, `h1`, description, support line, and waitlist link
3. A workstation element with `role="region"` and concise keyboard instructions
4. The interactive device scene
5. The command readout and replay control
6. A visually hidden static summary and a separate user-action status element

The device artwork is not the only source of product meaning. The heading,
description, waitlist action, and static state summary remain available when
CSS, animation, or JavaScript fails. Interactive keyboard instructions and demo
controls appear only after runtime readiness.

Do not use `role="application"`. Before hydration, the stage has no `tabindex`
and all demo controls are disabled. After the real simulation is ready, the
stage becomes a labelled `role="region"` with `tabindex="0"`. Its status element
uses `role="status"`, `aria-live="polite"`, and `aria-atomic="true"`, but updates
only after a user-driven command commits. This preserves standard browser
navigation and prevents inert no-JavaScript controls from entering the focus
order.

## Visual Direction

The reference at `https://hex.kitlangton.com/` is useful because it presents one
working object, gives each row one purpose, and uses operational state instead
of decoration. Paneform should borrow those principles, not its green terminal,
IRC framing, scanlines, grid, or control layout.

Paneform's distinct visual language is:

- A rose-tinted, shallow-perspective workstation
- Large areas of unbroken Rose Pine base color
- Thin structural lines and compact system labels
- A real keyboard and layout model rather than decorative keycaps
- Iris for window focus
- Foam or Pine for connected and powered states
- Rose Pine Love, Gold, and Pine for the three window controls
- A restrained emitted-light effect in dark mode
- Square or lightly rounded controls rather than large pills

The hardware is illustrative and carries no Apple logo. Its proportions should
be recognizable, but it should remain a Rose Pine line-and-surface rendering,
not a photorealistic product render.

## Appearance

Use `color-scheme: light dark` and one `prefers-color-scheme: light` media query.
There is no theme toggle, query parameter, cookie, local storage value, or user
setting. A system appearance change updates the scene without resetting the
simulation or timeline.

### Palette primitives

These are the only opaque color primitives. They come from the official Rose
Pine palette. Alpha colors and gradients must be derived from these primitives
with tokenized opacity or `color-mix()`.

| Role | Main | Dawn |
| --- | --- | --- |
| Base | `#191724` | `#faf4ed` |
| Surface | `#1f1d2e` | `#fffaf3` |
| Overlay | `#26233a` | `#f2e9e1` |
| Muted | `#6e6a86` | `#9893a5` |
| Subtle | `#908caa` | `#797593` |
| Text | `#e0def4` | `#464261` |
| Love | `#eb6f92` | `#b4637a` |
| Gold | `#f6c177` | `#ea9d34` |
| Rose | `#ebbcba` | `#d7827e` |
| Pine | `#31748f` | `#286983` |
| Foam | `#9ccfd8` | `#56949f` |
| Iris | `#c4a7e7` | `#907aa9` |

### Semantic color tokens

| Token | Main mapping | Dawn mapping | Use |
| --- | --- | --- | --- |
| `color.page.background` | Base | Base | Page and scene background |
| `color.page.foreground` | Text | Text | Main copy |
| `color.page.secondary` | Subtle | Text | Description and instructions |
| `color.page.quiet` | Subtle | Text | Small inactive labels, differentiated by weight |
| `color.surface.base` | Surface | Surface | Window and control surfaces |
| `color.surface.raised` | Overlay | Overlay | Dock, keycaps, raised controls |
| `color.line.default` | Muted at low opacity | Muted at low opacity | Hairlines |
| `color.line.strong` | Subtle | Subtle | Hardware edges |
| `color.device.shell` | Overlay mixed with Subtle | Overlay mixed with Muted | Laptop and monitor shell |
| `color.device.highlight` | Subtle at low opacity | Surface | Lit shell edge |
| `color.screen.background` | Base | Base | Powered display background |
| `color.screen.off` | Base mixed with Surface | Overlay mixed with Base | Unpowered display |
| `color.window.background` | Surface | Surface | Managed window body |
| `color.window.focus` | Iris | Iris | Focused window frame |
| `color.window.unfocused` | Subtle | Subtle | Unfocused frame |
| `color.workspace.text` | Text | Text | Workspace marker text |
| `color.workspace.accent` | Iris | Iris | Workspace marker edge or shape |
| `color.state.connected` | Foam | Pine | Cable contact and powered state |
| `color.state.warning` | Gold | Gold | Recoverable status |
| `color.state.error` | Love | Love | Failure status |
| `color.control.close` | Love | Love | Close circle |
| `color.control.minimize` | Gold | Gold | Minimize circle |
| `color.control.maximize` | Pine | Pine | Maximize circle |
| `color.key.label` | Text | Text | Idle keyboard legend |
| `color.key.active` | Foam | Pine | Pressed key legend |
| `color.key.edge.active` | Iris | Iris | Pressed key edge |
| `color.action.background` | Foam | Pine | Waitlist action |
| `color.action.foreground` | Base | Surface | Waitlist action text |
| `color.focus.ring` | Foam | Pine | Browser focus ring |
| `color.cable` | Subtle | Muted | Cable stroke |

Normal-size text never uses an alpha-reduced foreground. Small text uses only
the foreground combinations above. Decorative hairlines may use lower opacity,
but focus rings, window boundaries, key state, and other meaningful non-text
indicators must maintain at least `3:1` against adjacent colors. Automated
contrast tests cover every semantic foreground/background pair in both themes.

### Emissive treatment

Dark mode gives powered screen content and keyboard legends a low-luminance
emissive effect. It must look like display light reflecting through glass and
keycaps, not a neon outer glow.

- Idle screen text uses one tight Text-colored shadow at the screen-glow blur
  token and the `effect.glow.screenOpacity` token.
- Idle keyboard legends use a smaller Iris-colored shadow at the key-glow blur
  token and the `effect.glow.keyOpacity` token.
- A pressed key adds Foam-colored emission and a brighter top edge.
- The effect never changes layout, opacity, or legibility.
- Dawn uses no outer text shadow. It uses a tokenized inset edge highlight on
  keycaps and crisp text on screens.
- Reduced motion keeps the static low-level dark-mode glow because it does not
  move or pulse.

## Typography

Use a self-hosted variable build of Commit Mono for product copy, controls,
workspace labels, key readouts, and window labels. Use the system UI stack for
generic app glyphs only. Font files ship with the static site; no page-load font
request goes to a third party.

| Token | Value |
| --- | --- |
| `type.family.product` | Commit Mono with a system monospace fallback |
| `type.family.system` | System UI stack |
| `type.size.hero` | `clamp(2rem, 1.25rem + 3vw, 4.5rem)` |
| `type.size.body` | `clamp(0.875rem, 0.82rem + 0.25vw, 1.0625rem)` |
| `type.size.control` | `0.8125rem` |
| `type.size.label` | `0.6875rem` |
| `type.weight.regular` | `400` |
| `type.weight.medium` | `550` |
| `type.weight.strong` | `650` |
| `type.leading.hero` | `1.02` |
| `type.leading.body` | `1.55` |
| `type.tracking.label` | `0.12em` |

The heading uses sentence case. Technical labels may use uppercase. Do not use
all-uppercase prose.

## Token Contract

All authored visual values must come from design tokens. Runtime window frames
are data produced by Paneform and are not authored style values.

The implementation uses one canonical token source under the future site app,
for example `apps/site/src/lib/design/tokens.ts`. A build step emits typed
TypeScript values and CSS custom properties. The same source includes:

- Color primitives and semantic color references
- Type families, sizes, weights, line heights, and tracking
- Space, stroke, radius, opacity, shadow, and blur scales
- Breakpoints and scene dimensions
- Hardware geometry and screen coordinate systems
- Keyboard geometry
- Motion durations and easing curves
- Timeline cue times and key-hold durations
- Layer order

Use AST-aware lint rules for enforceable authored categories: colors, spacing,
type, radii, strokes, shadows, layers, motion, hardware dimensions, and camera
values. Component TypeScript must not contain authored scene coordinates,
display sizes, key widths, or timeline delays. Explicit structural exceptions
are `0`, `100%`, `auto`, intrinsic SVG path geometry, accessibility hiding
patterns, browser-compatibility fixes, mathematical coefficients, and values
computed from runtime Paneform frames. Every exception requires either a named
token reference or a short lint-disable reason. A text search for units is not a
sufficient enforcement mechanism.

### Core scales

| Family | Token values |
| --- | --- |
| Space | `0.25rem`, `0.5rem`, `0.75rem`, `1rem`, `1.5rem`, `2rem`, `3rem`, `4rem`, `6rem` |
| Stroke | `1px`, `2px`, `3px` |
| Radius | `2px`, `4px`, `8px`, `12px`, `18px` |
| Opacity | `0.08`, `0.14`, `0.22`, `0.4`, `0.64`, `0.88`, `1` |
| Glow blur | `0.35rem`, `0.65rem`, `1rem` |
| Layer | background, cable, monitor, laptop, cursor, readout, controls |

The page gutter is `clamp(1rem, 4vw, 4rem)`. The copy measure is `34rem`. The
hero minimum block size is `100svh`. These values are tokens, not literals in a
route or component.

### Required geometry and effect tokens

| Token | Value |
| --- | --- |
| `scene.perspective` | `1800` scene units |
| `scene.perspectiveOrigin` | `50% 45%` |
| `scene.safeArea` | `64` scene units |
| `scene.laptop.basePitch` | `62deg` |
| `scene.laptop.lidClosed` | `0deg` relative to base |
| `scene.laptop.lidOpen` | `104deg` relative to base |
| `scene.laptop.screenDepth` | `2` scene units |
| `scene.cable.stroke` | `3` scene units |
| `scene.cable.wideControlA` | `(0, 176)` from start |
| `scene.cable.wideControlB` | `(-138, 112)` from end |
| `scene.cable.stackControlA` | `(0, 160)` from start |
| `scene.cable.stackControlB` | `(-80, -100)` from end |
| `control.target.minimum` | `44px` projected size |
| `effect.glow.screenOpacity` | `0.22` |
| `effect.glow.keyOpacity` | `0.14` |
| `effect.glow.keyActiveOpacity` | `0.4` |
| `keyboard.unit` | `1` model unit |
| `keyboard.gap` | `0.08` keyboard units |
| `keyboard.bedWidth` | `16.04` keyboard units |
| `keyboard.radius` | `0.10` keyboard units |
| `keyboard.travel` | `0.06` keyboard units |
| `runtime.enhancementWatchdog` | `4000ms` |
| `runtime.bootstrapTimeout` | `8000ms` |
| `runtime.lazyIdleTimeout` | `1000ms` |

The canonical keyboard data source defines every row, key ID, code, legend,
unit width, and row offset. It is part of the generated token contract rather
than an ad hoc array inside `Keyboard.svelte`. The implementation is not ready
to merge until a visual fixture confirms that this matrix fits the tokenized
keyboard well without per-key CSS corrections.

## Hero Composition

### Initial composition

The copy is visible at first paint so the page communicates its purpose without
waiting for animation. It stays quiet at the edge of the composition. The
closed laptop is the only device and is centered in the scene viewport.

The initial camera fits the laptop with generous negative space. The laptop is
larger than it will be in the connected two-device composition. This is a camera
change, not a change to the hardware model.

### Connected composition

When the external display enters, the scene camera widens to show both devices
at one shared physical scale.

At wide widths, the Studio Display is on the left and the MacBook moves to the
right. At narrower widths, the Studio Display sits above the MacBook. The cable
path changes with the composition, but its anchors do not.

### Scene coordinate systems

Use one unitless hardware model in which the Studio Display enclosure is 1000
units wide. Responsive layouts change placement and camera framing, never the
device dimensions.

| Token | Wide composition | Stacked composition |
| --- | --- | --- |
| Scene model | `1760 x 1100` | `1100 x 1550` |
| Studio origin | `(80, 240)` | `(50, 40)` |
| MacBook origin | `(1178, 520)` | `(299, 880)` |
| Layout switch | Container width at least `72rem` | Container width below `72rem` |

The intro camera centers and fits the MacBook bounds. The connected camera fits
the union of both device bounds. Expand camera frame `F` by the scene-space safe
area before comparing it with CSS-pixel viewport `V`:

```text
paddedF = expand(F, scene.safeArea)
scale = min(V.width / paddedF.width, V.height / paddedF.height)
translate = center(V) - scale * center(paddedF)
```

Apply the camera in this order: viewport-center translation, uniform scale,
then negative camera-frame-center translation. A single stage
`ResizeObserver`, batched through one animation frame with equality guards,
recomputes camera fit, cable projection, cursor anchors, and final control-mode
projection. It never mutates child model geometry or Paneform coordinates.

The perspective lives inside the pre-camera scene model, where one scene unit is
represented by one CSS pixel before the outer camera scale. The outer camera
then scales the already projected model. Do not convert or subtract scene units
directly from viewport CSS pixels.

## Hardware Geometry

The model is based on Apple's published dimensions for a 14-inch M-series
MacBook Pro and 27-inch Studio Display.

| Hardware token | Value | Basis |
| --- | --- | --- |
| Studio enclosure width | `1000` scene units | Master unit |
| Studio enclosure height | `584` scene units | 24.5 by 14.3 inch enclosure |
| Studio active display | `959 x 539` scene units | 5120 by 2880 at 218 ppi |
| Studio total stand height | `767` scene units | 18.8 inch total height |
| MacBook chassis width | `502` scene units | 12.31 versus 24.5 inch width |
| MacBook base depth | `355` scene units | 8.71 versus 24.5 inch width |
| MacBook closed thickness | `25` scene units | 0.61 versus 24.5 inch width |
| MacBook lid height | `338` scene units | Active panel plus stylized bezel |
| MacBook active display | `485 x 315` scene units | 3024 by 1964 at 254 ppi |
| MacBook camera housing | `55 x 12` scene units | Approximate, centered exclusion |

The Studio Display is about 1.99 times the laptop enclosure width. Both final
responsive compositions must preserve that ratio. The laptop may appear larger
only while it is the sole device and the camera is fitted to it.

### Layout-engine displays

The layout engine works in fixed macOS logical points, independent of browser
size and the scene camera.

| Display | Frame | Work area | Scale |
| --- | --- | --- | --- |
| MacBook primary | `(0, 0, 1512, 982)` | `(0, 44, 1512, 830)` | `2` |
| Studio external | `(-2560, 0, 2560, 1440)` | `(-2560, 44, 2560, 1396)` | `2` |

The MacBook work area reserves a top safe band for the camera housing and a
bottom band for the visible fake dock. The Studio Display reserves only the top
status band. Paneform's layout gap is 16 logical points.

The external display stays logically left of the primary display, even when the
responsive artwork stacks it above the laptop. Responsive presentation must
not change workspace cycling order or layout results.

The scale invariants are:

```text
MacBook native pixels = 1512 x 982 logical points * 2 = 3024 x 1964
Studio native pixels  = 2560 x 1440 logical points * 2 = 5120 x 2880
Studio/Mac active physical width = (5120 / 218) / (3024 / 254) = 1.972
```

The physical ratio controls the scene rectangles. Logical point dimensions
control layout only. Browser device pixel ratio controls raster sharpness and
must not alter either model.

## MacBook Construction

Build the laptop with HTML and CSS 3D rather than WebGL.

- The base and lid are the two primary rectangular planes.
- The lid rotates around one hinge axis from the closed-angle token to the
  open-angle token.
- The outer shell, inner bezel, and screen are layers on the lid plane.
- The keyboard, speaker fields, and trackpad are children of the base plane.
- The keyboard inherits the base's complete 3D transform. It is never rendered
  as a separate screen-space overlay.
- The display surface is sized to the active hardware rectangle. Paneform
  frames position children as normalized percentages; do not create literal
  `1512 x 982` or `2560 x 1440` CSS surfaces.
- Backface visibility and overflow clipping prevent screen content from showing
  through the closed lid.

Apply one perspective at `SceneViewport`. Its origin comes from the perspective
origin token. Within it, use this transform order:

1. Place the laptop group in scene coordinates.
2. Apply the base pitch around the deck center.
3. Place the lid hinge at the rear deck edge.
4. Apply the lid angle around the hinge.
5. Offset the screen by the screen-depth token inside the lid.

Every 3D ancestor uses `transform-style: preserve-3d`. Do not put opacity,
filter, containment that flattens descendants, or clipping above the lid and
base. Clip only at the screen and hardware-shell boundaries. Cross-browser
tests must verify transform order, backface behavior, pointer hit testing, and
screen clipping.

The opening movement lasts 2.2 seconds. It uses the mechanical easing token and
slows as the lid reaches its stop. The base may settle by one small depth token,
but it must not bounce. The screen remains unpowered until the lid is nearly
open.

### Camera housing

The screen has rounded top corners and a centered housing. The approximate
logical exclusion is `(670, 0, 172, 37)` on the MacBook display plane. Background
may extend behind it. Workspace text, window title bars, and controls stay below
the complete 44-point safe band.

## Logo Signal

The laptop screen starts with the Screen Background token and no visible UI.
The provisional `paneform wm` lockup appears as a deterministic signal-lock
sequence:

1. A one-stroke horizontal Iris line appears at center.
2. Three clipped slices of the lockup appear with small opposite inline offsets.
3. The slices align into the stable lockup.
4. The lockup holds briefly, then resolves into the desktop and dock.

The full signal lasts 750 milliseconds. It has no random noise and no repeating
glitch. The animation operates on a wrapper mask, so a future SVG logo can
replace the text without new keyframes.

## Display UI

### Windows

Managed windows are deliberately generic. Each has:

- A thin frame
- A compact title bar
- Love, Gold, and Pine circles for close, minimize, and maximize
- An app title
- One large monochrome app glyph centered in the content area
- A visibly different focused frame

The three circles are visual chrome in this hero, not fake interactive buttons.
Dock icons and visible window bodies are the interactive controls. A window body
uses a named action such as `Focus Browser window` and dispatches the engine's
`focusWindow` command. This avoids exposing controls whose minimize and maximize
behavior is outside the demo contract.

The focused frame uses `color.window.focus` and the stronger frame stroke token.
Unfocused frames use `color.window.unfocused` and the hairline token. Focus must
remain clear without relying on glow.

Window frame changes animate for 320 milliseconds with the layout easing token.
Commit the new normalized geometry once, then run a FLIP or WAAPI wrapper using
only `translate3d` and `scale`. Do not drive position, width, height, or per-frame
progress through Svelte state. At the end, remove the inversion transform and
verify that the rendered frame equals Paneform's committed frame after local
display projection.

### Workspace marker

Each powered display shows one small workspace marker in its safe top band. It
uses a short form such as `ws / B`. Marker text uses `color.workspace.text`;
Iris is limited to its edge or adjacent shape. The marker updates from committed
engine state, not from the scripted timeline.

### Dock

The MacBook display has six apps in this order:

| App | Glyph direction | Demo use |
| --- | --- | --- |
| Clock | Hands in a circle | Initial generic window |
| Browser | Abstract compass or globe | Moved to workspace B |
| Terminal | Prompt and cursor | Moved to workspace T |
| Music | Note and waveform | Available to the user |
| Contacts | Two abstract silhouettes | Available to the user |
| Messages | Two speech rectangles | Moved to workspace M |

Use custom single-color SVG glyphs. Do not use Safari, Terminal, Music,
Contacts, Messages, or other app trademarks.

The visible stage caption calls this a `simulated macOS dock`. When it activates
an unopened app, status text first describes the OS-side event, for example
`macOS opens Browser`, and describes Paneform only after reconciliation, for
example `paneform tiles Browser`. This prevents the interaction from implying
that Paneform owns app launching.

Each app is a singleton in the simulated world. A dock action behaves as
follows:

1. Interrupt the scripted demo before applying the action.
2. Read the MacBook's currently visible workspace from committed state and
   execute `focusWorkspace` for it.
3. For a new app, call `sim.addWindow`, await `engine.reconcile`, and retain the
   returned window ID.
4. For an existing app elsewhere, execute `moveWindowToWorkspace` with its
   window ID and the MacBook workspace. Do not mutate simulator membership.
5. Execute `focusWindow` for the resulting window ID.
6. Publish one committed snapshot and update the dock indicator and frame.

The new or moved window is tiled by Paneform with every other window in that
workspace. The dock does not calculate frames.

Project dock target corners from the known model, lid, perspective, and target
camera matrices. Before a camera or lid animation begins, choose the control
mode from its final matrix. If either projected dimension is below the minimum
target token, make the in-screen dock decorative, non-focusable, and
pointer-inert, and enable the mirrored app rail below the scene. Otherwise,
enable the in-screen dock and hide and disable the rail. A coarse pointer may
force the rail, but both control sets must never be present in the accessibility
tree or tab order at once. The same rule applies to window-body focus actions
that project below the minimum target.

After `animation.finished`, verify the chosen mode with one
`getBoundingClientRect()` read. Perform any resulting attribute write in the
next animation frame. Never measure projected controls per frame or perform a
DOM write followed by a layout read in one frame.

Every dock operation is atomic at the presentation boundary. If a command
fails after `sim.addWindow` mutates the simulated platform, call
`sim.removeWindow(windowId)` and reconcile before accepting another action. If
that compensation also fails, dispose the runtime and restore the static
fallback. Otherwise retain the last coherent committed snapshot, show a concise
failure status, and leave the app available for another attempt.

## Studio Display And Cable

The external display begins absent. After the terminal reaches workspace T, the
camera widens and an unpowered Studio Display enters at its final position. Its
movement is a short fade and translation, not a spring.

Render the cable as an SVG cubic Bezier in scene coordinates:

- Start anchor: the Studio Display's bottom edge at 25 percent of its width
- End anchor: the left edge of the MacBook keyboard deck near the hinge
- Wide controls: the cable drops first, travels right, then rises into the deck
- Stacked controls: the cable drops from the monitor and curves into the deck
- Layer: behind both device faces and in front of the page background

The cable SVG lives entirely in the pre-camera scene model. Its start is a 2D
scene point. Its end is a 3D port anchor in laptop-local coordinates. Project
the end through the laptop and scene-perspective matrices exactly once, without
the outer camera transform, then use that pre-camera scene point in the path.
The outer camera transforms cable and devices together. Do not maintain a
visually similar second endpoint by eye. The wide and stacked Bezier control
offsets come from the geometry-token table.

The path uses `pathLength="1"`. Animate the tokenized stroke dash offset from
hidden to drawn. Small plug heads live at both ends. The endpoint emits one
brief connected-state highlight when contact is made.

The drawn plug reaches contact at active time `18.00`. The cable then holds fully
drawn while the command-budget interval runs through `18.15`, leaving 50
milliseconds of scheduling margin before power-on at `18.20`. At contact:

1. Call `sim.connectDisplay(studioDisplaySpec)`.
2. Await an explicit engine `reconcile` command.
3. Mark the physical display connected but still unpowered.
4. Run the power-on animation.

If connection reconciliation fails, call `sim.disconnectDisplay(studioId)` and
reconcile before another action can run. A failed compensation invalidates and
disposes the runtime rather than leaving hardware and committed state out of
sync.

The power-on animation begins as a Foam or Pine point at screen center, expands
to a thin horizontal line, then opens vertically into the desktop. It ends on a
stable, untextured display background. It runs once and lasts 2.3 seconds.

## Paneform Integration

Use `@paneform/layout-browser` for the simulated platform and the real
`@paneform/layout` engine for all tiling and workspace behavior.

Do not use the current `createLayoutSimulator` convenience function. It seeds
unrelated windows and starts with two displays. Do not mount the current debug
renderer in the hero. It includes inspector panels, a fixed sidebar, debugger
colors, and canvas chrome that cannot satisfy this token contract.

Before site implementation, export `DisplaySpec`, `AddWindowSpec`, and
`WebPlatformSimOptions` from the package root. If that small public type export
is intentionally deferred, derive local types from `Parameters` of the exported
simulator functions; do not deep-import unpublished source paths.

The hero bootstrap is:

1. Create `createWebPlatformSim` with only the MacBook display spec and a fixed
   seed.
2. Create the real engine with the simulator adapter, a browser clock, and an
   inline config source.
3. Configure BSP workspaces `1`, `M`, `B`, and `T` with the tokenized 16-point
   gap.
4. Start the engine and focus workspace `1`.
5. Add the initial Clock window and reconcile.
6. Read committed state into a token-driven Svelte renderer.

The renderer owns presentation only. For each committed window frame:

```text
localX = window.x - display.x
localY = window.y - display.y
inlineStart = localX / display.width
blockStart = localY / display.height
inlineSize = window.width / display.width
blockSize = window.height / display.height
```

The normalized values position a window in that display's fixed logical plane.
The MacBook and Studio planes then scale independently into their physically
proportioned active-display rectangles. The workstation camera applies last.

Do not calculate a single browser scale for the union of displays. Each screen
has a different physical size, logical resolution, and point density. The
display renderer must clip parked and hidden windows and render only the
workspace currently visible on that display.

One host adapter wraps Effect values with `Effect.runPromise`, converts expected
command errors into typed results, and returns the next committed snapshot.
Components and the timeline never run Effects directly.

Every engine command is awaited. After a simulated display connection, await an
explicit reconcile before moving a workspace so the command cannot race the
topology event.

### Action arbiter

Script, dock, window, and physical-keyboard actions pass through one serialized
arbiter. Each autoplay run owns a generation ID. Invalidating that ID prevents
future script actions and ignores stale subscriptions, but it does not pretend
to cancel an Effect already submitted to the engine.

When user input interrupts a submitted script command, the arbiter:

1. Invalidates the script generation and cancels pending waits and animations.
2. Lets the one submitted command reach a committed or failed result.
3. Reads that result as the new base state.
4. Runs the user's action next, so user intent is the final state.
5. Publishes only snapshots from the current runtime generation.

Treat `connectDisplay` plus explicit reconcile as one arbiter action because the
simulator mutation is synchronous. Treat `addWindow` plus reconcile the same
way. Each action owns its compensation path. The queue allows one submitted
action and at most one pending user intent; a newer pending intent replaces an
older unsubmitted one. Script actions cannot queue after generation
invalidation.

## Keyboard Model

Render a US ANSI 14-inch MacBook Pro keyboard, including the physical function
row, Escape, Touch ID placeholder, inverted-T arrows, and distinct left and
right modifiers.

The keyboard layout is data, not CSS selectors. Every key definition contains:

- A stable Paneform key ID such as `lshift`, `rshift`, or `m`
- A DOM physical code such as `ShiftLeft`, `ShiftRight`, or `KeyM`
- A displayed legend
- Row and column placement
- Width and height in keyboard units
- Optional alternate legend

Key gaps, corner radii, row offsets, cap heights, travel distance, and label
sizes are keyboard geometry tokens. The complete keyboard scales as one child
of the laptop base.

### Canonical ANSI matrix

The keyboard token source uses the `keyboard.bedWidth` token. Unmarked main-row
keys are one unit wide and one unit high. Rows are centered after gaps are
included.

```text
function: escape f1 f2 f3 f4 f5 f6 f7 f8 f9 f10 f11 f12 touch-id
number:   backquote 1 2 3 4 5 6 7 8 9 0 minus equal delete:1.5
qwerty:   tab:1.5 q w e r t y u i o p bracket-left bracket-right backslash:1.5
home:     caps-lock:1.75 a s d f g h j k l semicolon quote return:2.25
shift:    lshift:2.25 z x c v b n m comma period slash rshift:2.75
bottom:   fn control-left option-left command-left:1.25 space:5
          command-right:1.25 option-right arrow-left arrows-vertical arrow-right
```

`arrows-vertical` is one unit wide and contains half-height ArrowUp and
ArrowDown keys separated by the key-gap token. `touch-id` has no dispatchable
DOM code. The generated function-key width is the remaining bed width after
thirteen gaps, divided equally across fourteen caps. A visual fixture at
lid-open scale is the source of truth for final row offsets; component-local
corrections are not allowed.

Use `KeyboardEvent.code` as the primary physical mapping. This distinguishes
`ShiftLeft` from `ShiftRight` and follows physical position across character
layouts. `KeyboardEvent.location` and `key` may provide a visual fallback, but
they are not trusted to complete a side-specific chord. If left or right
identity is ambiguous, show a generic modifier in the command readout and do
not dispatch the command. If `navigator.keyboard.getLayoutMap()` is available,
update printable legends to the user's layout after the stage receives focus.
Do not guess an ISO or JIS physical shape that the browser cannot identify.

All recognized physical keys depress and illuminate while held, even when they
do not complete a Paneform command. Only registered chords dispatch commands.

## Keyboard Controller

Scripted and physical input share one controller. The public surface should be
equivalent to:

```ts
keyboard.press({ key: "lshift", hold: true });
keyboard.press({ key: "rshift", hold: true });
await keyboard.tap({ key: "m", duration: tokens.motion.chordHold });
keyboard.releaseAll();
```

The controller also exposes:

```ts
keyboard.release({ key: "lshift" });
keyboard.releaseAll({ source: "script" });
await keyboard.chord({
  keys: ["lshift", "rshift", "m"],
  preHold: tokens.motion.chordPrelude,
  hold: tokens.motion.chordHold,
  source: "script",
  signal,
});
```

Controller requirements:

- Track script and user presses separately; the rendered state is their union.
- Make press and release idempotent.
- Keep the state machine independent from DOM and accept injected keyboard
  layout, chord registry, scheduler, and command dispatcher dependencies.
- Make every timed operation asynchronous and `AbortSignal` aware. A `finally`
  block releases every key owned by an interrupted operation.
- Let `attach(stage)` return an idempotent detach function that removes all DOM
  and window listeners.
- Ignore repeated physical keydown events for command dispatch.
- Dispatch a chord once per full press cycle.
- Require exact registered modifiers; unrelated held modifiers prevent a match.
- Dispatch a user chord immediately when its trigger key goes down.
- Let scripted chords hold their modifiers before the trigger for teaching.
- Release script keys when the timeline is aborted without releasing keys the
  user is physically holding.
- Release user-owned keys on stage blur because a physical keyup may have been
  lost. Before window blur or page hide clears all sources, the demo runner must
  abort its active timed operation. Controller stop clears all sources.
- Expose pressed state to both the physical keyboard and command readout.
- Keep action lookup in a chord registry rather than the animation timeline.

The initial chord registry is:

| Chord | Command |
| --- | --- |
| `lshift + rshift + M` | Move focused window to workspace M and follow it |
| `lshift + rshift + B` | Move focused window to workspace B and follow it |
| `lshift + rshift + T` | Move focused window to workspace T and follow it |
| `lshift + rshift + Tab` | Move focused workspace to the next display |
| `rshift + B` | Focus workspace B |

The three move-window bindings execute `moveFocusedWindowToWorkspace`. The
display binding executes `moveFocusedWorkspaceToNextDisplay`. The focus binding
executes `focusWorkspace`.

The stage listens for `keydown` and `keyup` only while it owns focus. A lone Tab
retains normal browser behavior. Tab is prevented only when both physical Shift
keys are already down and the registered display chord matches. Other matched
chords prevent their trigger key's default behavior. Composition events and
events already prevented by another control are ignored. Events from links,
buttons, inputs, text areas, and selects are ignored; a dock activation returns
focus to the stage after its command settles. Escape releases all pressed state
without changing focus. Normal Tab remains the way to leave the stage.

## Command Readout

The physical keyboard can become small in the connected mobile composition.
Show the active chord a second time in a compact, legible command readout near
the stage edge.

The readout derives directly from controller state. It renders separate
rectangular key segments such as `L SHIFT`, `R SHIFT`, and `M`, plus a terse
result such as `move window -> M`. It must never claim a result before the
engine command commits.

The readout is visually hidden when no key is pressed and no recent command is
being acknowledged. It remains visible for the acknowledgement-duration token
after release. It is `aria-hidden` during scripted playback so it does not flood
screen readers.

## Scripted Demo

The demo is a declarative list of typed actions run by one cancellable timeline.
Do not build it from independent component timeouts. The initial cue sheet uses
about 30 seconds of active visible playback as a pacing baseline, not a release
gate. Motion review may lengthen a step that is hard to understand or shorten a
hold that feels idle. Time spent waiting for initialization, document
visibility, or stage visibility is not part of the measured playback time.

| Time | Action |
| --- | --- |
| `0.00-0.35` | Hold the closed, centered laptop and visible product copy after the active clock starts. |
| `0.35-2.55` | Open the laptop with the mechanical lid animation. Screen remains blank. |
| `2.55-3.00` | Hold the blank powered screen. |
| `3.00-3.75` | Run the `paneform wm` signal-lock animation. |
| `3.75-4.25` | Resolve to the desktop, dock, workspace 1 marker, and initial Clock window. |
| `4.25-5.10` | Let the first tiled window register visually. |
| `5.10-6.20` | Move the simulated cursor to Messages, click it, add its window, and tile it beside Clock. |
| `6.20-8.10` | Press left Shift, right Shift, then M. Move Messages to workspace M. Keep the full chord held for 1.5 seconds after M goes down. |
| `8.10-9.30` | Move to Browser, click, add its window to M, and tile it. |
| `9.30-11.20` | Press left Shift, right Shift, then B. Move Browser to workspace B. Keep the full chord held for 1.5 seconds. |
| `11.20-12.40` | Move to Terminal, click, add its window to B, and tile it. |
| `12.40-14.30` | Press left Shift, right Shift, then T. Move Terminal to workspace T. Keep the full chord held for 1.5 seconds. |
| `14.30-15.50` | Widen the camera and bring in the unpowered Studio Display. |
| `15.50-18.20` | Draw the cable through 18.00, then connect and reconcile while the completed cable holds through 18.20. |
| `18.20-20.50` | Run the Studio Display power-on animation. |
| `20.50-22.60` | Press left Shift, right Shift, then Tab. Move workspace T to the Studio Display. Keep the full chord held for 1.5 seconds. |
| `22.60-23.80` | Hold the two-display result. Terminal is visible on the Studio Display. |
| `23.80-25.80` | Press right Shift, then B. Focus workspace B on the MacBook. Keep the full chord held for 1.55 seconds. |
| `25.80-27.20` | Hold Browser on the MacBook and Terminal on the Studio Display. |
| `27.20-30.00` | Fade the simulated cursor, show `Demo complete. Try it.`, and expose replay. |

The timeline uses one monotonic active clock. The times below are the first
prototype's configurable cue values, with explicit committed-state
prerequisites. Engine work is expected
to commit within the command-budget token already reserved inside its cue. If a
prerequisite or command exceeds that budget, do not overlap dependent steps or
speed up later animation. Stop autoplay at the last coherent state, hand over to
the user, and show `Demo paused. Try it.`. The supported-device browser test must
finish the configured path without overlapping or skipping dependent actions.
Record total active time in motion-review builds so pacing changes are
deliberate.

Each scripted dock slot uses these maximum offsets from its cue start: cursor
arrival at `500ms`, click feedback complete and command submitted at `590ms`,
command committed and FLIP started by `740ms`, and window animation complete by
`1060ms`. The Messages slot therefore retains 40 milliseconds of margin; the
Browser and Terminal slots retain 140 milliseconds. These offsets are timeline
tokens, and cursor, press, and command work are sequential rather than assumed
to overlap.

Three-key chord slots use these offsets from their cue start:

| Offset | Event |
| --- | --- |
| `0ms` | First modifier down |
| `140ms` | Second modifier down |
| `350ms` | Trigger down and command submitted |
| `1850ms` | Trigger up after a 1500ms full-chord hold |
| `1875ms` | Second modifier up |
| `1900ms` | First modifier up and slot complete |

The two-key `rshift + B` slot uses right Shift at `0ms`, B and command submission
at `250ms`, B up at `1800ms`, Shift up at `1825ms`, and leaves the remainder of
its 2-second slot for acknowledgement. These offsets are timeline tokens. A
result appears in the readout only after the submitted command commits.

The scripted cursor resolves dock targets by element anchor, not stored pixel
coordinates. A resize during playback therefore changes its path without
changing the action sequence.

An always-visible `Pause demo` control sits beside the status while autoplay is
running. It remains outside the keyboard-capture region. Pausing invalidates the
active timed keyboard or presentation operation, releases its keys, and pauses
the active clock and animation registry after any submitted engine command
settles. Its label becomes `Resume demo`. If the trigger was not submitted,
resume restarts that cue; if it was submitted, resume starts at the next cue.
Completion or takeover replaces this control with replay.

Autoplay starts once, after client initialization, when at least 60 percent of
the stage is visible and the document is visible. When less than 20 percent of
the stage remains visible, an `IntersectionObserver` pauses the active clock,
aborts the current timed operation, and cancels its registered WAAPI animations.
Document hide does the same and then releases all pressed keys. Visibility pause
follows the same cue rule as the Pause control: restart a cue whose trigger was
not submitted, or advance only after a submitted command settles. The demo does
not loop after inactivity.

Listen for live `prefers-reduced-motion` changes. If it changes to reduce during
autoplay, abort presentation work, settle a submitted command through the
arbiter, fast-forward the remaining typed engine actions without motion, and
enter the reduced-motion interactive final state. If it changes back, preserve
the current interactive state; do not restart autoplay. Replay then follows the
preference active when replay begins.

## Interruption And Takeover

The following actions interrupt autoplay before their effect is applied:

- A dock or mirrored app-rail activation
- A recognized physical keydown while the stage is focused
- A pointer activation on a visible window

On interruption:

1. Abort the timeline with one `AbortController`.
2. Release only script-owned keyboard presses.
3. Remove the simulated cursor.
4. Invalidate the autoplay generation so no later script action can submit.
5. Stop script-owned WAAPI animations and settle the laptop open.
6. Let one already-submitted engine command settle through the action arbiter;
   it cannot be cancelled safely.
7. Queue the user's action after that result so user intent commits last.
8. Keep the external display absent if connection did not commit, or complete
   its static powered state if connection did commit.
9. Preserve the resulting committed windows, focus, and display assignments.
10. Show `You're in control.` and enable replay.

Visual takeover, cursor removal, and future-script invalidation must happen by
the next refresh interval after input, targeted at 16.7 milliseconds on a 60 Hz
display. The queued user command may commit later but must meet the INP target.
Do not reset the scene, rewind a submitted window move, or continue later
scripted steps.

Replay is single-flight. It invalidates the current queue, calls the runtime's
idempotent `dispose()`, then creates a fresh engine and simulator with the
original fixed seed. Disposal first discards unsubmitted work and waits only for
the one in-flight action. Replay clears pressed keys and user-created windows,
disconnects the external display, returns the laptop to the closed solo
composition, and runs the same data-driven timeline. Reset and startup share one
bootstrap path, and stale runtime generations cannot publish snapshots.

## Responsive Behavior

Use container queries for scene composition and normal fluid layout for copy.
Do not choose hardware geometry from `window.innerWidth`.

### Wide

- Copy stays at the upper inline edge inside the page gutter.
- The intro camera centers the MacBook in the viewport.
- The connected camera places Studio Display left and MacBook right.
- The command readout sits near the laptop without covering its screen.
- Both devices fit within the hero's safe viewport with their shadows.

### Stacked

- Copy is in normal flow above the scene.
- The Studio Display is above the MacBook after connection.
- The final device width ratio remains `1000:502`.
- The cable curves downward into the laptop's upper-left deck edge.
- The command readout sits between copy and hardware or below the hardware,
  whichever preserves screen visibility.
- A mirrored app rail becomes the only interactive app control when measured
  projected dock targets are below the minimum target token or a coarse pointer
  forces the accessible mode.

### Resize rules

- Preserve engine coordinates and state.
- In one animation-frame batch, recompute camera fit, cable endpoint projection,
  cursor anchors, and matrix-projected target mode. Container queries choose
  device placement. Verify DOM target bounds only after the scene settles.
- Do not restart or skip the timeline.
- During a composition switch, crossfade the cable path and transition the
  camera with the scene-reframe motion token.
- Keep heading, CTA, replay, and stage instructions within the safe viewport.

Test at minimum `390 x 844`, `768 x 1024`, `1440 x 900`, and `1920 x 1080` CSS
pixels in both appearances.

## Motion Tokens

| Token | Value | Use |
| --- | --- | --- |
| `motion.duration.press` | `90ms` | Key and button travel |
| `motion.duration.feedback` | `160ms` | Focus and indicator response |
| `motion.duration.window` | `320ms` | Window frame interpolation |
| `motion.duration.cursor` | `650ms` | Typical cursor travel |
| `motion.duration.cursorShort` | `500ms` | Scripted dock travel |
| `motion.duration.logo` | `750ms` | Logo signal |
| `motion.duration.monitorEnter` | `1200ms` | External hardware entrance |
| `motion.duration.sceneReframe` | `1200ms` | Solo-to-connected camera |
| `motion.duration.lid` | `2200ms` | Laptop opening |
| `motion.duration.wire` | `2500ms` | Cable drawing before reconcile hold |
| `motion.duration.power` | `2300ms` | Studio Display startup |
| `motion.duration.chordStagger` | `140ms` | Modifier sequencing |
| `motion.duration.chordPrelude` | `210ms` | Delay from second modifier to trigger |
| `motion.duration.chordHold` | `1500ms` | Full three-key hold |
| `motion.duration.twoKeyPrelude` | `250ms` | Right Shift to B trigger |
| `motion.duration.twoKeyHold` | `1550ms` | Full two-key hold |
| `motion.duration.keyReleaseStagger` | `25ms` | Scripted key release order |
| `motion.duration.commandBudget` | `150ms` | Deterministic local command budget |
| `motion.duration.acknowledge` | `500ms` | Readout after key release |
| `motion.duration.reducedFade` | `120ms` | Reduced-motion state acknowledgement |
| `motion.easing.standard` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | General transition |
| `motion.easing.mechanical` | `cubic-bezier(0.16, 1, 0.3, 1)` | Lid and hardware |
| `motion.easing.layout` | `cubic-bezier(0.22, 1, 0.36, 1)` | Committed frame change |
| `motion.easing.linear` | `linear` | Cable stroke only |

Timeline cue values also live in the token source. Components never repeat the
durations in local styles or scripts.

## Reduced Motion

When `prefers-reduced-motion: reduce` matches:

- Do not autoplay.
- Keep the prerendered final illustration visible while runtime state starts.
- Fast-forward the same typed simulation actions in order with presentation
  durations set to zero: create apps, move M/B/T, connect and reconcile the
  Studio Display, move T, then focus B.
- Enable demo controls only after the engine's committed snapshot contains
  Browser/B on the MacBook and Terminal/T on the Studio Display.
- Render the laptop open, cable complete, and Studio Display powered from that
  committed state.
- Keep dock, app rail, stage keyboard input, and waitlist action interactive
  after fast-forward completes.
- Replace window motion with a short opacity change.
- Do not animate the lid, camera, cursor, logo slices, cable, or power-on effect.
- Keep the static dark-mode emissive treatment.
- Make replay dispose and bootstrap again, then fast-forward the same logical
  actions with instant state changes and short fades. It must not override the
  system motion preference.

## Accessibility

- Product copy and the waitlist action are fully usable before hydration.
- All text and interactive states meet WCAG 2.2 AA contrast.
- The waitlist action and the one enabled set of demo controls meet the
  44-by-44-CSS-pixel projected target token.
- The stage has a visible `focus-visible` ring that does not depend on glow.
- Pause/Resume is visible, named, and keyboard operable throughout autoplay.
- Dock, mirrored app, and window focus controls have names such as
  `Open Browser` and `Focus Browser window`.
- Focus order follows DOM order, not visual 3D position.
- The static summary is `Workstation simulation. Browser workspace B is on the
  MacBook. Terminal workspace T is on the external display.` The separate live
  status updates politely only after user-driven committed actions.
- Scripted playback does not announce every cursor, key, or frame event.
- Visual focus, pressed keys, and connection state use shape or stroke in
  addition to color.
- The stage does not trap Tab. Only an exact registered Tab chord is consumed.
- Escape releases all simulated pressed keys without changing focus.
- Page hide, browser blur, and stage blur cannot leave a modifier visually held.
- Pointer interaction remains available when no physical keyboard exists.
- The decorative hardware, cable, and scripted cursor are hidden from the
  accessibility tree.
- No-JavaScript and failed-runtime demo controls stay disabled and out of the
  focus order; the waitlist and privacy links remain active.

If CSS 3D is unsupported, show an open, front-facing static laptop and display.
If the simulation fails to initialize, keep the static final scene, copy, and
CTA; show a quiet `Interactive demo unavailable` status without an error stack.

## Static Site Architecture

Use SvelteKit with `@sveltejs/adapter-static` rather than introducing Astro for
this page. The interaction is state-heavy, the project already uses TypeScript,
and Svelte is the team's familiar tool.

The future site can live at `apps/site` in the current pnpm workspace. The WM
route is `apps/site/src/routes/wm/+page.svelte`. The root layout exports
`prerender = true` and `trailingSlash = "always"`, producing
`build/wm/index.html`. Use adapter-static with no SPA fallback, relative asset
paths, optional precompression, and SSR enabled. The CDN must map both `/wm` and
`/wm/` to that object without an origin server; the canonical URL remains
`https://paneform.com/wm`. The deployment smoke test requests `/wm`, `/wm/`, and
one generated asset through production-equivalent CDN routing.

Suggested implementation boundaries are:

| Boundary | Responsibility |
| --- | --- |
| `WmHero.svelte` | Copy, CTA, stage lifecycle, fallback state |
| `Workstation.svelte` | Camera, hardware composition, cable, cursor |
| `DisplaySurface.svelte` | Reusable logical display projection and window layer |
| `Keyboard.svelte` | Tokenized key geometry and pressed-state rendering |
| `Dock.svelte` | App controls and singleton app actions |
| `createHeroSimulation.ts` | Simulator, engine, config, commands, reset |
| `action-arbiter.ts` | Serialized script and user command ownership |
| `keyboard-controller.ts` | Physical and scripted keyboard state |
| `demo-runner.ts` | Cancellable typed timeline |
| `demo-timeline.ts` | Declarative baseline cue and action data |
| `simulation-client.ts` | Tree-shaken lazy import facade |
| `generate-hero-snapshot.ts` | Build-time final Paneform fallback state |
| `tokens.ts` | Canonical design, geometry, and timing tokens |

This is a separation by transform or state ownership, not a requirement to
split every visual fragment into a component.

### Build-time fallback snapshot

Do not hand-author final fallback window frames. Before prerendering, run the
DOM-free simulator and real layout engine under Node with the same seed, config,
display specs, and typed engine actions used by reduced-motion fast-forward.
Write the final committed display, workspace, window, frame, and focus data to a
generated static module. SSR uses that module for the no-JavaScript display
layer.

The build test compares this generated snapshot with a runtime fast-forward
snapshot, ignoring only runtime IDs that are deliberately normalized. A mismatch
fails the build. Hardware geometry still comes from design tokens; the generated
module owns only Paneform state.

### Hydration-stable first paint

SSR and the first client render use identical keyed DOM. The markup contains
the hardware shells, a static final display layer, an initially hidden dynamic
display layer, and disabled demo controls. It does not branch on `browser` or a
client media query during render.

A tiny inline script in the document head sets an enhancement marker before CSS
and body paint. With that marker, normal-motion CSS presents the same hardware
DOM as one closed, centered laptop and hides the static final display layer.
Without JavaScript, the marker is absent, so CSS presents the open two-display
final illustration and leaves demo controls disabled. Reduced-motion CSS keeps
the final illustration visible while the real engine fast-forwards.

The head script also starts the tokenized enhancement-watchdog timer. The main
client bundle claims the marker as soon as hydration starts, before lazy
simulation loading. If no claim arrives before the watchdog expires, the script
removes the marker and restores the static final illustration. The inline script
ships with a CSP hash.

Starting the lazy simulation starts a separate bootstrap timeout. If runtime
readiness does not arrive before it expires, invalidate and dispose partial
state, restore the static layer, and show `Interactive demo unavailable`. A
claimed enhancement marker must therefore never hide the fallback indefinitely.

After hydration and successful bootstrap, atomically mark the static layer
hidden, inert, and `aria-hidden`, reveal the dynamic layer, set the runtime-ready
marker, enable the correct control set, and add the stage `tabindex`. Exactly one
display layer is visible or exposed to accessibility APIs. On failure, reverse
those attributes, remove the enhancement marker, and retain the static final
illustration. These steps change attributes and presentation only; they do not
replace or hydrate a different DOM tree.

The static shell reserves the final scene size. Start loading after
`window.load`, followed by one bounded idle period, but begin earlier on
explicit stage focus or pointer intent. Dynamically import one local
`simulation-client.ts` facade that uses static named imports from Paneform and
Effect. Do not dynamically import broad package namespaces from the route.
Autoplay's active clock starts only after this chunk and the engine are ready.

### Runtime disposal

Bootstrap returns one idempotent asynchronous `dispose()` operation. It
invalidates the runtime generation, aborts initialization and timeline work,
detaches keyboard and window listeners, disconnects observers, cancels every
registered animation and animation frame, unsubscribes engine state, releases
keys, discards unsubmitted queue work, awaits only the one in-flight action, and
then awaits `engine.stop()`. A late dynamic import may resolve, but its stale
generation is disposed without publishing state. Use SvelteKit `onNavigate` to
await disposal before client navigation. Component destruction still performs
the synchronous invalidation and detach steps immediately as a fallback. Replay
awaits the complete operation.

## Performance

- Use CSS 3D, SVG, and DOM; do not add Three.js or a WebGL scene.
- Animate hardware, cursor, keycaps, monitor, and logo wrappers with transforms
  and opacity. Use localized SVG stroke or mask animation only for cable and
  power-on effects.
- Animate window geometry with compositor-first FLIP wrappers. Do not update
  Svelte state on animation frames.
- Redraw display windows only after committed engine state changes.
- Keep the scripted cursor and cable in the scene coordinate system.
- Use one `ResizeObserver` at the stage boundary and batch its work into one
  guarded animation frame.
- Pause the active clock and animation registry while the page is hidden or the
  hero is materially offscreen.
- Load the tree-shaken simulation facade after `window.load` and the bounded
  idle token, or immediately on user intent. Inspect the production bundle to
  ensure debug renderer and panel code are absent.
- Keep logical resolutions as engine data and render normalized DOM surfaces at
  hardware-model size. Do not allocate logical-resolution DOM or canvas planes.
- Subset and self-host the one product font. Use `font-display: swap`, tokenized
  fallback metrics, and a compressed font budget below 80 KB.
- Avoid raster device images and image-set variants.
- Target LCP below 2.5 seconds, CLS below 0.05, and INP below 200 milliseconds on
  the documented release-test mobile device and network profile.
- Target a static-shell JavaScript budget below 100 KB compressed and a lazy
  interactive chunk below 300 KB compressed. The production bundle report is a
  release gate and includes Svelte, Paneform, Effect, and the hero runtime.
- Target compressed HTML below 35 KB, route CSS below 30 KB, and all critical
  inline SVG below 45 KB.
- Complete parsing and engine initialization before active playback. During
  playback and takeover, no main-thread task may exceed one 60 Hz frame budget
  on the release-test device. Separately retain the standard 50-millisecond
  long-task audit across initial load, replay, and teardown.
- Run a replay and route-navigation soak that verifies stable listener,
  observer, animation, engine, and heap counts after disposal.

### Release test profile

Performance gates use current stable Chromium in CI at a `412 x 915` viewport,
device-pixel ratio `2.625`, 60 Hz, cold cache, four-times CPU slowdown, 150 ms
round-trip latency, 1.6 Mbps download, and 750 Kbps upload. Run five clean
iterations and gate on the median Web Vital result; retain all traces for frame
and long-task inspection.

Payload gates use aggregate gzip level 9 size. Static-shell size includes every
script needed before the lazy trigger. Interactive size includes the complete
transitive dynamic graph not already counted in the shell, including shared
chunks. Also report Brotli level 11 for CDN planning, but gzip is the release
gate. The trace verifies that loading starts after `window.load` plus the
bounded idle token, unless pointer or focus intent starts it earlier.

## State Model

Keep these state domains separate:

| Domain | Examples |
| --- | --- |
| Lifecycle | static, loading, autoplay, interactive, resetting, failed |
| Hardware | lid angle, camera frame, monitor present, cable connected, power state |
| Paneform | committed displays, workspaces, windows, frames, focus |
| Input | pressed keys by source, matched chord, stage focus |
| Actions | runtime generation, serialized owner, submitted command, queue state |
| Presentation | cursor target, command acknowledgement, registered animations |

Paneform state is authoritative for windows and workspaces. Hardware state is
authoritative for whether a display can be connected. The timeline requests
state transitions; it does not own the resulting state.

## Validation Plan

### Unit tests

- Left and right modifier mapping from physical events
- Script and user key ownership
- Exact chord matching and repeat suppression
- Tab default behavior outside the registered chord
- Timeline duration and cue order under a fake clock
- Exact keydown, command, and keyup offsets for two- and three-key chords
- Timeline abort at every action boundary
- Pause and visibility behavior before and after trigger submission
- Live reduced-motion preference changes during each demo phase
- Timed keyboard operation cancellation and listener detach
- Display-local coordinate projection for positive and negative origins
- Native-pixel, logical-point, PPI, and hardware-scene scale invariants
- Model-space camera fit and single-application cable projection
- Singleton dock behavior and focus changes
- One-in-flight/one-pending action queue replacement
- Fresh deterministic reset and replay
- System appearance changes without state reset
- Contrast for every semantic foreground/background pair in Main and Dawn
- Enhancement watchdog, bootstrap timeout, and fallback restoration

### Integration tests

- Real `@paneform/layout` final frames for one, two, and three windows
- `M`, `B`, and `T` move-window behavior
- Display connect followed by explicit reconcile
- T workspace move to Studio Display
- B workspace focus on the MacBook after T moves
- Interruption by dock and physical keyboard input
- Interruption while a scripted command or display reconcile is submitted;
  verify that the queued user action commits last
- `addWindow` and `connectDisplay` compensation after reconciliation failure
- Renderer output equals committed engine coordinates after every transition
- Reduced-motion fast-forward and final committed engine state
- Build-generated fallback snapshot matching runtime fast-forward geometry
- Simulation failure fallback
- Idempotent disposal after startup, interruption, replay, and route teardown

### Browser tests

- Current Safari, Chrome, and Firefox on macOS
- Current iOS Safari and Android Chrome for touch behavior
- Keyboard events for `ShiftLeft`, `ShiftRight`, `KeyM`, `KeyB`, `KeyT`, and Tab
- Dark, light, reduced-motion, no-JavaScript, and forced-colors modes
- Automated accessibility checks plus manual keyboard navigation
- Visual snapshots at the four required viewport sizes
- No horizontal overflow at 320 CSS pixels
- Hydration with no warnings, node replacement, or final-to-closed flash
- Atomic static-to-dynamic display-layer handoff with one accessible layer
- Transformed hit testing, clipping, backfaces, and projected target switching
- Active visible playback matching the configured cue total, with the measured
  duration included in motion-review output
- Visual takeover by the next 60 Hz refresh interval
- Direct static requests for `/wm`, `/wm/`, and generated assets
- Production bundle report proving debug renderer code is absent
- Replay/navigation soak with stable resources and heap trend

### Token enforcement

Add AST-aware source checks for colors, spacing, type, radii, strokes, shadows,
layers, motion, device geometry, and authored scene coordinates. Permit the
documented structural exceptions, canonical token source, generated files, test
fixtures, compatibility fixes with reasons, and runtime Paneform frame data.
Test the lint rule with accepted and rejected fixtures.

## Acceptance Criteria

The hero is ready for implementation review when all of the following are true:

- The first enhanced frame has one centered, closed 14-inch MacBook Pro.
- The laptop opens smoothly from two primary 3D planes and reveals a correctly
  transformed keyboard and screen.
- The screen stays blank before the one-shot `paneform wm` signal animation.
- A generic Clock window and six-app dock appear after the logo.
- Dock actions add or move one singleton window, tile it through Paneform, and
  visibly focus it.
- Exactly one dock or mirrored app control set is interactive, focusable, and at
  least 44 by 44 projected CSS pixels.
- Focused and unfocused windows have distinct AA-compliant frame treatments.
- The demo performs the requested M, B, T, external-display, Tab, and B-focus
  sequence with roughly 30-second baseline pacing, adjusted when motion review
  finds a step rushed or unnecessarily slow.
- Every scripted chord remains fully visible for at least 1.5 seconds.
- Left and right Shift press different physical keys in both script and user
  input.
- Every supported physical key press updates the transformed keyboard while the
  stage is focused.
- The Studio Display connects only when the Bezier cable reaches the laptop.
- The cable reaches contact at 18.00 seconds, connection reconciliation commits
  by 18.15 seconds, and only then does the Studio Display power on at 18.20.
- Browser workspace B finishes visible on the MacBook and Terminal workspace T
  finishes visible on the Studio Display.
- Any actionable dock or keyboard input invalidates future autoplay by the next
  refresh interval; if a script command was submitted, the user action runs
  immediately after it and commits last.
- Replay uses the same typed actions and keyboard controller as first playback.
- A visible Pause/Resume control can stop and continue autoplay without losing
  or duplicating a chord command.
- Main and Dawn follow the live system preference with no user configuration.
- Dark-mode screen text and key legends have a subtle static emissive treatment;
  Dawn has none.
- Reduced motion fast-forwards the real engine to the static two-display state
  before enabling interaction.
- Final device dimensions preserve the published MacBook-to-Studio width ratio
  in wide and stacked layouts.
- Paneform receives fixed logical display sizes whose scale reproduces the
  published native resolutions; browser resizing changes only projection,
  measured hit targets, and scene camera transforms.
- The route builds to static files and works behind a file CDN with no origin
  server, including direct requests to `/wm` and `/wm/`.
- SSR and first hydration use identical DOM and produce no final-to-closed flash.
- The no-JavaScript final window frames come from a build-time run of the same
  Paneform engine actions and match reduced-motion runtime state.
- Replay and route teardown leave no live engine, listener, observer, animation,
  or stale state publisher.
- The production bundle meets the documented payload gates and excludes the
  layout-browser debug renderer.
- UI components contain no hard-coded authored visual values outside the token
  system and documented structural exceptions.

## Required Inputs Before Production

The design can be prototyped without these items, but production needs:

- Final monochrome Paneform WM logo or approval of the text lockup
- Production waitlist URL and privacy destination
- Final Commit Mono font files and license notice
- Confirmation that the requested M, B, T, and display chords are the public
  defaults; the repository does not currently contain the active production
  keymap

## References

- Hex reference: <https://hex.kitlangton.com/>
- Rose Pine palette: <https://github.com/rose-pine/palette/blob/main/palette.json>
- 14-inch MacBook Pro specifications: <https://support.apple.com/en-us/121552>
- Studio Display specifications: <https://www.apple.com/studio-display/specs/>
- SvelteKit static adapter: <https://svelte.dev/docs/kit/adapter-static>
- Physical keyboard codes: <https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/code>
- Paneform browser renderer guide: `docs/rewrite/web-renderer.md`
- Paneform product behavior: `docs/spec.md`
- Browser simulator: `packages/layout-browser/src/sim/web-platform.ts`
- Layout commands: `packages/layout/src/commands.ts`
