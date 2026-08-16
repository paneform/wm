import Testing
@testable import WMInventory

@Test func topologySortsDisplaysAndConvertsFramesToAXCoordinates() {
    let displays = [
        display("above", frame: .init(x: 200, y: 800, width: 800, height: 600)),
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
        display("above", frame: .init(x: 200, y: 800, width: 800, height: 600)),
    ]
    let window = RawAXWindow(
        pid: 1, appName: "Test", role: "AXWindow", frame: .init(x: 300, y: -500, width: 200, height: 100)
    )

    #expect(WindowNormalizer.normalize(ax: [window], cg: [], displays: displays).windows.first?.displayID == "above")
}

private func display(
    _ id: String, primary: Bool = false, frame: InventoryRect
) -> DisplayObservation {
    .init(
        id: id, name: id, isBuiltin: primary, isPrimary: primary, frame: frame, visibleFrame: frame,
        backingScale: 1, identifiers: .init()
    )
}
