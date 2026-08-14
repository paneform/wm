# Feature 02: macOS Inventory And Identity

Owns AppKit display inventory, Accessibility app/window inventory, Core Graphics
window inventory, source health, provisional joining, classification, and raw
diagnostics.

Dependencies: protocol/domain contracts.

Does not own WebSocket, CLI, BSP, workspace state, or mutation.

Acceptance criteria:

- AX and CG are collected independently.
- One failed/hung app does not abort all inventory.
- Missing/zero/duplicate CG IDs do not crash or overwrite records.
- Join decisions expose confidence and signals.
- Uncertain/rejected windows expose reasons.
- Raw inventory remains available for diagnostics.
