import ApplicationServices
import Testing
@testable import wm_sidecar

@Test func nativeWriteErrorsAreClassified() {
    #expect(AdapterError.writeFailure(.success) == nil)
    #expect(AdapterError.writeFailure(.invalidUIElement)?.wireCode == "stale")
    #expect(AdapterError.writeFailure(.cannotComplete)?.wireCode == "not_controllable")
    #expect(AdapterError.writeFailure(.illegalArgument)?.wireCode == "rejected")
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
