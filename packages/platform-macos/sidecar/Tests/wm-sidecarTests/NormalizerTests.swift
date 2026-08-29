import Testing

@testable import wm_sidecar

@Suite struct NormalizerTests {
    @Test func joinsUniqueSamePidExactFrameWhenTitlesDiffer() {
        let frame = Rect(x: 756, y: 32, width: 756, height: 950)
        let joined = Normalizer.normalize(
            ax: [axWindow(title: "Activity Monitor - All Processes", frame: frame)],
            cg: [cgWindow(id: 47, title: "Activity Monitor", frame: frame)],
            hiddenPids: [])

        #expect(joined.map(\.value.id) == ["window:cg:47"])
    }

    @Test func rejectsAmbiguousSamePidExactFrameCandidates() {
        let frame = Rect(x: 756, y: 32, width: 756, height: 950)
        let joined = Normalizer.normalize(
            ax: [axWindow(title: "Activity Monitor - All Processes", frame: frame)],
            cg: [
                cgWindow(id: 47, title: "Activity Monitor", frame: frame),
                cgWindow(id: 48, title: "Processes", frame: frame),
            ],
            hiddenPids: [])

        #expect(joined.isEmpty)
    }

    private func axWindow(title: String, frame: Rect) -> RawAXWindow {
        RawAXWindow(
            pid: 650,
            appName: "Activity Monitor",
            bundleID: "com.apple.ActivityMonitor",
            executablePath: "/System/Applications/Utilities/Activity Monitor.app/Contents/MacOS/Activity Monitor",
            title: title,
            role: "AXWindow",
            subrole: "AXStandardWindow",
            frame: frame,
            minimized: false,
            fullscreen: false,
            focused: true,
            main: true,
            modal: false,
            hasParent: false,
            movable: true,
            resizable: true,
            cgWindowID: nil,
            readErrors: [])
    }

    private func cgWindow(id: UInt32, title: String, frame: Rect) -> RawCGWindow {
        RawCGWindow(
            cgWindowID: id,
            pid: 650,
            title: title,
            onScreen: true,
            frame: frame)
    }
}
