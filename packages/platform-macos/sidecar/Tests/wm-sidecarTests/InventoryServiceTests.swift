import Testing

@testable import wm_sidecar

@Suite struct InventoryServiceTests {
    @Test func focusedWindowBelongsToFrontmostApplication() {
        let windows = [
            "activity": window(id: "activity", pid: 650, focused: true),
            "terminal": window(id: "terminal", pid: 629, focused: true),
        ]

        #expect(InventoryService.focusedWindowID(in: windows, frontmostPID: 629) == "terminal")
        #expect(InventoryService.focusedWindowID(in: windows, frontmostPID: 650) == "activity")
    }

    @Test func focusedWindowRequiresFrontmostFocusedCandidate() {
        let windows = ["activity": window(id: "activity", pid: 650, focused: true)]

        #expect(InventoryService.focusedWindowID(in: windows, frontmostPID: 629) == nil)
        #expect(InventoryService.focusedWindowID(in: windows, frontmostPID: nil) == nil)
    }

    private func window(id: String, pid: Int, focused: Bool) -> WindowValue {
        WindowValue(
            id: id,
            pid: pid,
            bundleId: nil,
            executablePath: nil,
            title: id,
            role: "AXWindow",
            subrole: "AXStandardWindow",
            frame: FrameValue(x: 0, y: 0, width: 800, height: 600),
            minimized: false,
            hidden: false,
            fullscreen: false,
            focused: focused,
            capabilities: CapabilitiesValue(
                movable: "supported",
                resizable: "supported",
                movableEvidence: "platform_report",
                resizableEvidence: "platform_report"))
    }
}
