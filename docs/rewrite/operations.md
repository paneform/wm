# TypeScript WM Operations

The production window manager is the TypeScript engine with the persistent
macOS sidecar. It listens on `127.0.0.1:17832`, loads
`~/.config/wm/config.jsonc`, and is supervised by the per-user launchd service
`com.allandeutsch.wm`.

Architectural rationale, including the native hotkey-monitor latency decision,
is recorded in [`docs/design-decisions.md`](../design-decisions.md).

```sh
scripts/create-local-signing-identity.sh
swift build -c release --package-path packages/platform-macos/sidecar
scripts/package-local-wm-app.sh
scripts/wm-service.sh install
scripts/wm-service.sh status
scripts/wm-service.sh restart
scripts/wm-service.sh stop
```

Logs are under `${XDG_STATE_HOME:-~/.local/state}/wm/logs`. The service starts
the sidecar once and native keybind actions travel over its existing IPC pipe;
skhd must remain disabled to avoid duplicate bindings. Config changes hotload
without restarting the service.

Learned geometry profiles and pending evidence are stored at
`${WM_OBSERVATIONS:-${XDG_STATE_HOME:-~/.local/state}/wm/observations.json}`. The
daemon loads this catalog before its first layout and watches atomic replacements
for external corrections. A concurrent writer must use the adjacent
`observations.json.lock` protocol and compare the content revision; direct editing is
safe only while the daemon is stopped. A stale lock is not stolen automatically because
doing so could admit two writers; remove it only after confirming its recorded PID is
gone. An invalid startup file is renamed with a `.corrupt-<timestamp>` suffix and rebuilt.

The launchd-owned native host launches one TypeScript child over private inherited
protocol pipes. That child also runs the SketchyBar publisher, which converts
TypeScript state to the existing bar snapshot shape and triggers
`wm_workspace_change` after atomic snapshot writes.

The bootstrap creates the fixed local identity `WM Local Code Signing`; it never creates
an identity from `WM_CODESIGN_IDENTITY`. Its private key is encrypted while staged and
imported as non-exportable into `~/Library/Keychains/wm-local-signing.keychain-db`.
macOS asks for that dedicated Keychain's password during creation. Before packaging,
unlock `wm-local-signing` in Keychain Access; the package script relocks it on exit.
The Keychain locks after five minutes, on sleep, and immediately after the script exits,
so the identity is unavailable outside an explicit packaging run. Delete the dedicated
Keychain and remove its user trust setting through Keychain Access when it is no longer
needed. Replacing or renewing the certificate changes the app identity and requires new
privacy grants.

Run bootstrap only in a trusted local session. Its random one-time PKCS#12 passphrase is
briefly visible to same-user processes during import. Normal exits remove the encrypted
temporary artifacts; after an interrupted bootstrap, remove any abandoned
`${TMPDIR:-/tmp}/wm-signing.*` directory before retrying.

Packaging resolves exactly one valid identity and signs by certificate fingerprint.
Set `WM_CODESIGN_IDENTITY` to an exact certificate name or fingerprint and optionally
set `WM_CODESIGN_KEYCHAIN` when an Apple identity is available. Local signing gives
development builds a stable designated requirement, but it does not replace Developer
ID signing or notarization for distribution.

After replacing an older ad-hoc build, clear its stale privacy records once:

```sh
tccutil reset Accessibility com.allandeutsch.wm
tccutil reset ScreenCapture com.allandeutsch.wm
tccutil reset ListenEvent com.allandeutsch.wm
```

Then add the packaged `~/.local/libexec/wm/WM.app` in Accessibility, Screen & System
Audio Recording, and Input Monitoring before starting the service. Release distribution
uses the Developer ID and notarization workflow tracked by `wm-v9ea`.
