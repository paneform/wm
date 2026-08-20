# Window Management Rules

## New Window Placement

Place a newly detected window using this precedence:

1. Restore its existing workspace membership, including recognized replacements after sleep, wake, or inventory loss.
2. Apply its configured workspace affinity.
3. Place it in the currently focused workspace.
4. Use workspace `1` only when no focused or visible workspace exists, such as initial startup.

Detecting or assigning a new window must not, by itself, change the focused workspace.
