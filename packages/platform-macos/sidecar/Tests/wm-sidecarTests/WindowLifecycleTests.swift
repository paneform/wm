import ApplicationServices
import Darwin
import Testing

@testable import wm_sidecar

@Suite struct WindowLifecycleTests {
    @Test func processStartIdentityCanBeReadWithoutApplicationRegistration() {
        let state = WindowLifecycle.processState(getpid())
        guard case .running(let start) = state else {
            Issue.record("the current process must have readable start identity")
            return
        }
        #expect(!start.isEmpty)
        #expect(WindowLifecycle.processState(getpid()) == state)
    }
    private func window(element: AXUIElement) -> Normalizer.Joined {
        let raw = RawAXWindow(
            pid: 42, appName: "CAD", bundleID: nil, executablePath: nil,
            title: "project", role: "AXWindow", subrole: "AXStandardWindow",
            frame: Rect(x: 0, y: 32, width: 800, height: 600), minimized: false,
            fullscreen: false, focused: false, main: true, modal: false, hasParent: false,
            movable: true, resizable: true, cgWindowID: 100, readErrors: [],
            reference: AXWindowReference(element: element))
        return Normalizer.normalize(
            ax: [raw],
            cg: [
                RawCGWindow(
                    cgWindowID: 100, pid: 42, frame: raw.frame)
            ], hiddenPids: [])[0]
    }

    @Test func unavailableAndFilteredWindowsRetainInstanceWithoutActionableGeometry() {
        var lifecycle = WindowLifecycle()
        let original = window(element: AXUIElementCreateApplication(42))
        let first = lifecycle.reconcile(joined: [original], stalled: [], processState: { _ in .running("start") })
        let missing = lifecycle.reconcile(
            joined: [], stalled: [42], processState: { _ in .unavailable },
            elementInvalid: { _ in
                Issue.record("must not probe stalled app")
                return false
            })
        #expect(missing.windows.isEmpty)
        #expect(missing.unavailable == [original.value.id])
        #expect(missing.closed.isEmpty)
        var restored = original
        restored.raw.subrole = "AXDialog"
        let later = lifecycle.reconcile(joined: [restored], stalled: [], processState: { _ in .running("start") })
        #expect(first.windows[0].value.instanceId == later.windows[0].value.instanceId)
    }

    @Test func reusedPidOrDifferentWindowReferenceGetsANewInstance() {
        var lifecycle = WindowLifecycle()
        let original = window(element: AXUIElementCreateApplication(42))
        let first = lifecycle.reconcile(joined: [original], stalled: [], processState: { _ in .running("old") })
        let reused = lifecycle.reconcile(joined: [original], stalled: [], processState: { _ in .running("new") })
        #expect(first.windows[0].value.instanceId != reused.windows[0].value.instanceId)
        var different = window(element: AXUIElementCreateApplication(43))
        different.cgWindowID = nil
        let replaced = lifecycle.reconcile(
            joined: [different], stalled: [],
            processState: { _ in .running("new") })
        #expect(reused.windows[0].value.instanceId != replaced.windows[0].value.instanceId)
    }

    @Test func stableSurfaceSurvivesRebuiltAXHandleAndNormalizedIDChanges() {
        var lifecycle = WindowLifecycle()
        let original = window(element: AXUIElementCreateApplication(42))
        let first = lifecycle.reconcile(joined: [original], stalled: [], processState: { _ in .running("start") })
        var refreshed = window(element: AXUIElementCreateApplication(43))
        refreshed.value.id = "temporary-ax-id"
        let later = lifecycle.reconcile(joined: [refreshed], stalled: [], processState: { _ in .running("start") })
        #expect(later.windows[0].value.id == original.value.id)
        #expect(later.windows[0].value.instanceId == first.windows[0].value.instanceId)
        let missing = lifecycle.reconcile(
            joined: [], stalled: [],
            cgWindows: [RawCGWindow(cgWindowID: 100, pid: 42)],
            processState: { _ in .running("start") }, elementInvalid: { _ in true })
        #expect(missing.closed.isEmpty)
        #expect(missing.unavailable == [original.value.id])
    }

    @Test func onlyPositiveClosureEvidenceRetiresAnInstance() {
        for exited in [false, true] {
            var lifecycle = WindowLifecycle()
            let original = window(element: AXUIElementCreateApplication(42))
            let first = lifecycle.reconcile(joined: [original], stalled: [], processState: { _ in .running("start") })
            let closed = lifecycle.reconcile(
                joined: [], stalled: [],
                processState: { _ in exited ? .exited : .running("start") }, elementInvalid: { _ in true })
            #expect(closed.closed == [original.value.id])
            #expect(closed.unavailable.isEmpty)
            let reopened = lifecycle.reconcile(
                joined: [original], stalled: [], processState: { _ in .running("start") })
            #expect(first.windows[0].value.instanceId != reopened.windows[0].value.instanceId)
        }
    }
}
