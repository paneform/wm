import Testing

@testable import wm_sidecar

@Suite struct WindowSourceTests {
    private func cgWindow(pid: Int32, layer: Int = 0, onScreen: Bool = true) -> RawCGWindow {
        RawCGWindow(
            cgWindowID: UInt32(max(pid, 0)), pid: pid, title: nil, onScreen: onScreen,
            frame: Rect(x: 0, y: 32, width: 1512, height: 950), ownerName: "Bambu Studio", layer: layer)
    }

    @Test func discoversUnregisteredWindowOwnerOnceIncludingParkedWindows() {
        let registered = applications([1])
        let candidates = WindowSource.discoverApplications(
            registered: registered,
            cgWindows: [cgWindow(pid: 1), cgWindow(pid: 2, onScreen: false), cgWindow(pid: 2)],
            resolve: { pid, name in
                .init(
                    pid: pid, name: name ?? "unknown", bundleID: "com.bambulab.bambu-studio",
                    executablePath: "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio")
            })
        #expect(candidates.map(\.pid) == [1, 2])
        #expect(candidates[0].name == "test")
        #expect(candidates[1].bundleID == "com.bambulab.bambu-studio")
        #expect(candidates[1].name == "Bambu Studio")
    }

    @Test func skipsInvalidOwnersAndNonWindowSurfaces() {
        var empty = cgWindow(pid: 3)
        empty.frame = Rect(x: 0, y: 0, width: 0, height: 0)
        let candidates = WindowSource.discoverApplications(
            registered: [], cgWindows: [cgWindow(pid: 0), cgWindow(pid: 2, layer: 101), empty],
            resolve: { pid, _ in .init(pid: pid, name: "unexpected", bundleID: nil, executablePath: nil) })
        #expect(candidates.isEmpty)
    }

    @Test func unregisteredBambuLikeAppSurvivesCollectionAndNormalization() async {
        let cg = [cgWindow(pid: 35063)]
        let candidates = WindowSource.discoverApplications(
            registered: [], cgWindows: cg,
            resolve: { pid, name in
                .init(
                    pid: pid, name: name ?? "Bambu Studio",
                    bundleID: "com.bambulab.bambu-studio", executablePath: nil)
            })
        let (ax, stalled) = await WindowSource.collectAXWindows(
            applications: candidates, previouslyStalled: [], frontmostPID: nil,
            enumerate: { app, _ in
                [
                    RawAXWindow(
                        pid: app.pid, appName: app.name, bundleID: app.bundleID, executablePath: app.executablePath,
                        title: nil, role: "AXWindow", subrole: "AXStandardWindow",
                        frame: Rect(x: 0, y: 32, width: 1512, height: 950), minimized: false,
                        fullscreen: false, focused: false, main: true, modal: false, hasParent: false,
                        movable: true, resizable: true, cgWindowID: nil, readErrors: [])
                ]
            })
        let normalized = Normalizer.normalize(ax: ax, cg: cg, hiddenPids: [])
        #expect(stalled.isEmpty)
        #expect(normalized.count == 1)
        #expect(normalized.first?.value.pid == 35063)
        #expect(normalized.first?.value.bundleId == "com.bambulab.bambu-studio")
    }

    private func applications(_ pids: [Int32]) -> [WindowSource.KnownApplication] {
        pids.map { .init(pid: $0, name: "test", bundleID: nil, executablePath: nil) }
    }

    @Test func skippedStalledAppsStayStalledAndExitedPidsAreRemoved() async {
        let (_, stalled) = await WindowSource.collectAXWindows(
            applications: applications([1, 2, 3]), previouslyStalled: [1, 2, 3, 4],
            frontmostPID: nil, allowStalledRetryAfter: false,
            enumerate: { _, _ in nil })
        #expect(stalled == [1, 2, 3])
    }

    @Test func successfulRotatedProbeClearsOnlyItsOwnStall() async {
        let (_, stalled) = await WindowSource.collectAXWindows(
            applications: applications([1, 2, 3]), previouslyStalled: [1, 2, 3],
            frontmostPID: nil, retryOffset: 2,
            enumerate: { app, _ in app.pid == 3 ? [] : nil })
        #expect(stalled == [1, 2])
    }

    @Test func focusedAppIsProbedEvenWhenItIsOutsideTheRetrySubset() async {
        let (_, stalled) = await WindowSource.collectAXWindows(
            applications: applications([1, 2, 3, 4]), previouslyStalled: [1, 2, 3, 4],
            frontmostPID: 4, retryOffset: 0,
            enumerate: { app, _ in app.pid == 4 ? [] : nil })
        #expect(stalled == [1, 2, 3])
    }
}
