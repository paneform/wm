# Window Management Rules

## New Window Placement

Place a newly detected window using this precedence:

1. Restore its existing workspace membership, including recognized replacements after sleep, wake, or inventory loss.
2. Apply its configured workspace affinity.
3. Place it in the currently focused workspace.
4. Use workspace `1` only when no focused or visible workspace exists, such as initial startup.

Detecting or assigning a new window must not, by itself, change the focused workspace.

Before inserting a newly detected window into workspace membership or its layout tree:

1. Compute its intended workspace and target frame without mutating committed workspace state.
2. Apply and verify that target frame on the new window first.
3. Only after verification succeeds, insert the window and rearrange the rest of the workspace.
4. If preflight fails, leave committed workspace membership and layout unchanged and keep the window outside management until a later rule or retry resolves it.

This ordering prevents an unverified window from disrupting an existing workspace and provides the quarantine boundary for windows that report fixed geometry or fail controllability checks.
