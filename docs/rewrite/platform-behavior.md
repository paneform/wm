# Imperfect Platform Behavior

wm treats the platform as observable and influenceable, not perfectly knowable or
controllable. Its working model has two parts:

- **Layout intent** records what wm is trying to preserve, such as workspace membership,
  BSP structure, focus intent, and parked frames.
- **Current usable observations** describe windows and displays that the platform can
  identify and read now.

The engine plans only from usable observations. Intent may survive an observation gap,
but remembered placement is not a stale window fact and cannot by itself authorize a
write. This distinction lets wm recover from temporary platform failures without
pretending that missing data is current data.

## Observation Is Not Certainty

Native AX, Core Graphics, process, and display facts are normalized behind the
[platform contract](./platform-contract.md). The boundary projects them into portable
semantics: canonical geometry, actionable windows, opaque lifetime identity, explicit
unavailability, and positive closure evidence. The engine does not reason directly from
macOS-specific handles or callbacks.

The optional `getWindowInventory` result separates `windows`, `unavailableWindowIds`,
and `closedWindowIds`. An unavailable inventory fails instead of returning an empty
list. Likewise, a known but unreadable window is unavailable, not closed. Inventory
absence, a timeout, filtering, or a failed AX/CG join does not prove destruction. wm
retires remembered placement only after positive closure or replacement evidence.

Placement has no time-to-live. A returning window can reclaim it only when its lifetime
identity matches. The portable comparison uses window ID, PID, and `instanceId` when the
platform supplies one, with a weaker application/role fallback otherwise. On macOS,
`WindowLifecycle` preserves an `instanceId` across gaps by matching the retained AX
element or a Core Graphics window ID together with the verified process start time. A
process exit, changed process start, or invalid element without a surviving CG surface
can close the old lifetime. Titles and frames are not lifetime identities.

## Reconciliation Loop

The implemented lifecycle is described in the [engine guide](./engine-guide.md) and
encoded in [`lifecycle.ts`](../../packages/layout/src/lifecycle.ts):

1. **Observe:** query and validate topology and window inventory.
2. **Plan:** combine current actionable facts with committed layout intent.
3. **Act:** issue identity-guarded platform operations.
4. **Observe again:** settle-poll writes and refresh affected windows.
5. **Verify, commit, or reconcile:** publish successful reconciliation after convergence;
   otherwise report failure, compensate where possible, or run another bounded pass.

Command acceptance therefore does not mean physical success. A platform call may be
accepted while an application clamps, delays, redirects, or ignores the requested
geometry. Settle readbacks can also disagree with each other. The geometry service
classifies observed outcomes, uses a bounded retry ladder, and reports exhausted or
still-progressing work honestly. Native multi-window operations are not physically atomic.
Compound commands commit layout intent after verification. They capture prior frames and
perform best-effort reverse compensation after partial failure, guarded by identity so a
replacement window is not moved by mistake.

wm learns constraints only from eligible observed outcomes. Stable clamp-shaped results
can contribute evidence, while stalled applications, unchanged initial frames, work-area
clamps, and progressing animations are excluded. Behavioral probes are controlled
nudges followed by readback and restoration. They improve observation; they are not a
second layout control loop.

Focus follows the same rule. Global platform focus is authoritative. An inactive
application's local focused or main-window flag is not. Ordered focus events and
verified focus commands take precedence over lagging inventory snapshots; snapshots
mainly bootstrap focus before an authoritative signal exists.

## Examples

**Sleep and wake.** Before sleep, the macOS host marks inventory unavailable. During
the gap, wm does not turn an empty or failed read into mass closure and does not plan
geometry for the missing windows. After wake, it waits for a fresh inventory. A window
whose lifetime identity matches can recover its remembered workspace placement; a
confirmed replacement receives normal new-window placement. Recovery then uses fresh
geometry rather than a cached frame.

**Geometry and focus lag.** Suppose wm reveals a workspace, requests a frame, and then
focuses its window. The application may animate toward a different size, while an
activation event reports that the user focused another app. wm reads the frame until a
bounded settle point, classifies the actual result, and keeps the newer global focus
signal. It may retry geometry with another write strategy, learn an eligible size
constraint, or fail and compensate earlier moves. It does not equate successful API
returns with the requested desktop state.

## Limits

This is not an implemented `ready`/`suspended`/`recovering` state machine, nor a general
per-fact confidence or evidence store. The transaction queue has a recovery gate, and
the engine reports degraded health, but those mechanisms do not establish OS truth.
Uncertain data stays uncertain. Bounded retries can end without convergence;
compensation can fail; fallback identity is weaker when no lifetime token exists; and a
platform may change after the final readback.

Diagnostics explain observation errors, failed operations, and recovery decisions.
Read-only platform queries can gather more detail without activating or moving windows.
Neither is a competing control loop. The design protects how wm uses platform evidence;
it cannot guarantee that the evidence is true. wm preserves intent cautiously, uses
eligible observations, and reports when observation or recovery was incomplete.
