import ApplicationServices
import Testing

@testable import wm_sidecar

@Test func componentRequestsPreserveUntouchedLiveGeometry() {
    let baseline = Rect(x: 100, y: 200, width: 640, height: 480)
    #expect(
        GeometryAdapter.componentTarget(
            Rect(x: 10, y: 20, width: 0, height: 0), baseline: baseline, components: [.position])
            == Rect(x: 10, y: 20, width: 640, height: 480))
    #expect(
        GeometryAdapter.componentTarget(
            Rect(x: 0, y: 0, width: 800, height: 600), baseline: baseline, components: [.size])
            == Rect(x: 100, y: 200, width: 800, height: 600))
    let full = Rect(x: 10, y: 20, width: 800, height: 600)
    #expect(
        GeometryAdapter.componentTarget(
            full, baseline: baseline,
            components: [.size, .position, .size]) == full)
}

@Test func nativeWriteErrorsAreClassified() {
    #expect(AdapterError.writeFailure(.success) == nil)
    #expect(AdapterError.writeFailure(.invalidUIElement)?.wireCode == "stale")
    // .cannotComplete is an AX messaging timeout: a stalled app, distinct
    // from permission/attribute problems (bean wm-site).
    #expect(AdapterError.writeFailure(.cannotComplete)?.wireCode == "unresponsive")
    #expect(AdapterError.writeFailure(.apiDisabled)?.wireCode == "not_controllable")
    #expect(AdapterError.writeFailure(.attributeUnsupported)?.wireCode == "not_controllable")
    #expect(AdapterError.writeFailure(.illegalArgument)?.wireCode == "rejected")
}

@Test func settleEarlyExitRequiresAppliedEvidence() {
    // Reached the target: always settles early.
    #expect(GeometryAdapter.shouldSettleEarly(targetSamples: 3, stableSamples: 0, distanceImproved: false))
    // Stable but never improved toward the target: a never-applied write to a
    // hung app must keep polling instead of returning false stable evidence
    // (bean wm-ixs4).
    #expect(!GeometryAdapter.shouldSettleEarly(targetSamples: 0, stableSamples: 3, distanceImproved: false))
    // Stable after moving toward the target: a WindowServer-level instant
    // clamp still settles fast.
    #expect(GeometryAdapter.shouldSettleEarly(targetSamples: 0, stableSamples: 3, distanceImproved: true))
    // Not stable yet: keep polling.
    #expect(!GeometryAdapter.shouldSettleEarly(targetSamples: 0, stableSamples: 2, distanceImproved: true))
}

@Test func windowMetaPreservesAXWindowIdentity() {
    let raw = RawAXWindow(
        pid: 42,
        appName: "Example",
        bundleID: "com.example.app",
        executablePath: "/Applications/Example.app/Contents/MacOS/Example",
        title: "Example",
        role: "AXWindow",
        subrole: "AXStandardWindow",
        frame: Rect(x: 0, y: 0, width: 800, height: 600),
        minimized: false,
        fullscreen: false,
        focused: true,
        main: true,
        modal: false,
        hasParent: false,
        movable: true,
        resizable: true,
        cgWindowID: 7,
        readErrors: [])

    let meta = WindowMeta(
        id: "window:cg:48",
        raw: raw,
        cgTitle: nil,
        cgWindowID: 48,
        hidden: false)

    #expect(meta.axWindowID == 7)
}
