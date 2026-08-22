import Testing
@testable import WMInventory

// Observations are canonicalized at the platform boundary (AX global space,
// top-left origin of the primary display, y-down); the topology exposes them
// directly and provides the single engine-local <-> OS projection pair.

@Test func topologySortsDisplaysAndExposesCanonicalOSFrames() {
    let displays = [
        display("above", frame: .init(x: 200, y: -600, width: 800, height: 600)),
        display("primary", primary: true, frame: .init(x: 0, y: 0, width: 1000, height: 800)),
    ]
    let topology = DisplayTopologySnapshot(displays: displays)

    #expect(topology.displays.map(\.id) == ["above", "primary"])
    #expect(topology.axFrames["primary"] == .init(x: 0, y: 0, width: 1000, height: 800))
    #expect(topology.axFrames["above"] == .init(x: 200, y: -600, width: 800, height: 600))
}

@Test func windowNormalizationUsesCanonicalAXDisplayFrames() {
    let displays = [
        display("primary", primary: true, frame: .init(x: 0, y: 0, width: 1000, height: 800)),
        display("above", frame: .init(x: 200, y: -600, width: 800, height: 600)),
    ]
    let window = RawAXWindow(
        pid: 1, appName: "Test", role: "AXWindow", frame: .init(x: 300, y: -500, width: 200, height: 100)
    )

    #expect(WindowNormalizer.normalize(ax: [window], cg: [], displays: displays).windows.first?.displayID == "above")
}

@Test func projectionMapsEngineLocalFramesToOSAndBack() {
    let displays = [
        display("primary", primary: true, frame: .init(x: 0, y: 0, width: 1000, height: 800)),
        // Physically above-left of the primary.
        display("dell", frame: .init(x: -1030, y: -1440, width: 3440, height: 1440)),
    ]
    let topology = DisplayTopologySnapshot(displays: displays)

    let local = InventoryRect(x: 10, y: 20, width: 300, height: 200)
    let projected = try! #require(topology.project(local, onDisplay: "dell"))
    #expect(projected == .init(x: -1020, y: -1420, width: 300, height: 200))

    let roundTripped = try! #require(topology.unproject(projected, onDisplay: "dell"))
    #expect(roundTripped == local)
}

@Test func projectionOnSingleDisplayIsWorkAreaTranslation() {
    let displays = [
        display("primary", primary: true, frame: .init(x: 0, y: 0, width: 1000, height: 800)),
    ]
    let topology = DisplayTopologySnapshot(displays: displays)

    let local = InventoryRect(x: 0, y: 0, width: 100, height: 50)
    let projected = try! #require(topology.project(local, onDisplay: "primary"))
    #expect(projected == local)
    #expect(try! #require(topology.unproject(local, onDisplay: "primary")) == local)
}

@Test func projectionReturnsNilForUnknownDisplay() {
    let topology = DisplayTopologySnapshot(displays: [display("primary", primary: true, frame: .init(x: 0, y: 0, width: 10, height: 10))])
    #expect(topology.project(.init(x: 0, y: 0, width: 1, height: 1), onDisplay: "missing") == nil)
    #expect(topology.unproject(.init(x: 0, y: 0, width: 1, height: 1), onDisplay: "missing") == nil)
}

private func display(
    _ id: String, primary: Bool = false, frame: InventoryRect
) -> DisplayObservation {
    .init(
        id: id, name: id, isBuiltin: primary, isPrimary: primary, frame: frame, visibleFrame: frame,
        backingScale: 1, identifiers: .init()
    )
}
