---
# wm-c86u
title: Make WM.app self-contained entrypoint
status: completed
type: feature
priority: high
created_at: 2026-08-29T00:43:05Z
updated_at: 2026-08-31T17:30:20Z
---

Build one self-contained signed WM.app that is the native permission identity, daemon host, and user-facing CLI.

- [x] Define and test native dispatch for sidecar, host, and CLI modes
- [x] Bundle the JavaScript application and Node runtime into WM.app
- [x] Remove repository and external runtime paths from installed service configuration
- [x] Install one stable wm command pointing to WM.app
- [x] Document installation and runtime behavior
- [x] Run focused and full validation

## Validation

- Full tests pass: engine 304, renderer 23, node host 46, platform TypeScript 15, Swift 15.
- Lint, typecheck, build, shell syntax, bundle generation, CLI help, native permissions, and the pre-hardening signed bundle smoke tests pass.
- Quality and security review findings were addressed: canonical bundle lookup and signature validation, environment sanitization, safe plist generation, pinned Node 24 signer/dependency checks, signal forwarding, service shutdown ownership, and install rollback ordering.

## Deployment

The final bundle was signed with hardened runtime, installed atomically, and restarted through the bundled service command. Deep signature verification, runtime bundle validation, native permission checks, CLI state, and launchd service status all pass.

## Summary of Changes

WM.app is now the single native entrypoint for CLI, sidecar IPC, daemon hosting, permissions, and service lifecycle. The app bundles a standalone JavaScript CLI and verified Node 24 runtime, installs ~/.local/bin/wm, and no longer depends on the repository or a system Node installation at runtime. Packaging verifies the Node Foundation signature and system-only dylibs, signs WM with hardened runtime, and rolls back atomically. Runtime dispatch validates the signed bundle, sanitizes child environments, forwards termination signals, and safely generates launchd plists. Full tests, lint, typecheck, build, signed-bundle smoke tests, and final security review pass with no release-blocking findings.

## Commit Verification

- Fresh tests, lint, typecheck, build, Swift tests, shell syntax, and diff checks pass.
- The pending commit was scanned for private keys, certificate bundles, passwords, credentials, and sensitive signing material; none were found. Signing references are public identifiers or local environment/keychain references only.
