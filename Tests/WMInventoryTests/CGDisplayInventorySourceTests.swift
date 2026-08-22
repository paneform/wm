import Testing
import CoreGraphics
import Foundation
@testable import WMInventory

private struct StubEnumerator: CGDisplayEnumerator {
    var online: [CGDirectDisplayID]?
    var activeIDs: Set<CGDirectDisplayID> = []
    var builtinIDs: Set<CGDirectDisplayID> = []
    var mainID: CGDirectDisplayID?
    var boundsByID: [CGDirectDisplayID: CGRect] = [:]
    var pixelWidths: [CGDirectDisplayID: Int] = [:]
    var uuidPrefix = "UUID-"

    func onlineDisplayList() -> [CGDirectDisplayID]? { online }
    func isActive(_ displayID: CGDirectDisplayID) -> Bool { activeIDs.contains(displayID) }
    func isBuiltin(_ displayID: CGDirectDisplayID) -> Bool { builtinIDs.contains(displayID) }
    func isMain(_ displayID: CGDirectDisplayID) -> Bool { displayID == mainID }
    func bounds(of displayID: CGDirectDisplayID) -> CGRect {
        boundsByID[displayID] ?? .zero
    }
    func pixelWidth(of displayID: CGDirectDisplayID) -> Int { pixelWidths[displayID] ?? 0 }
    func vendorNumber(of displayID: CGDirectDisplayID) -> UInt32 { 0x610 }
    func modelNumber(of displayID: CGDirectDisplayID) -> UInt32 { 0x9227 }
    func serialNumber(of displayID: CGDirectDisplayID) -> UInt32 { 0 }
    func uuidString(for displayID: CGDirectDisplayID) -> String? {
        "\(uuidPrefix)\(displayID)"
    }
}

private func snapshot(
    _ displayID: CGDirectDisplayID, name: String, frame: CGRect, visibleFrame: CGRect,
    scale: CGFloat
) -> NSScreenSnapshot {
    .init(
        displayID: displayID, name: name, frame: frame, visibleFrame: visibleFrame,
        backingScale: scale)
}

@Test func cgInventoryUsesCanonicalUUIDIdentifiersAndCGGeometry() throws {
    let builtin: CGDirectDisplayID = 1
    let external: CGDirectDisplayID = 2
    let enumerator = StubEnumerator(
        online: [external, builtin],
        builtinIDs: [builtin],
        mainID: builtin,
        boundsByID: [
            builtin: CGRect(x: 0, y: 0, width: 1512, height: 982),
            // Physically above-left of the primary; CGDisplayBounds is already
            // canonical OS space, so the observation keeps these coordinates.
            external: CGRect(x: -1512, y: -1440, width: 3440, height: 1440),
        ],
        pixelWidths: [external: 3440])

    let result = SystemDisplayInventorySource.result(enumerator: enumerator, screens: [])

    #expect(result.health.status == .healthy)
    #expect(result.value.map(\.id) == ["display:uuid-1", "display:uuid-2"])
    let observationsById = Dictionary(uniqueKeysWithValues: result.value.map { ($0.id, $0) })
    #expect(observationsById["display:uuid-1"]?.isPrimary == true)
    #expect(observationsById["display:uuid-1"]?.isBuiltin == true)
    #expect(observationsById["display:uuid-1"]?.frame == .init(x: 0, y: 0, width: 1512, height: 982))
    #expect(observationsById["display:uuid-2"]?.frame == .init(x: -1512, y: -1440, width: 3440, height: 1440))
}

@Test func cgInventorySynthesizesFallbacksForDisplaysMissingFromAppKitCache() throws {
    let stale: CGDirectDisplayID = 1
    let hotPlugged: CGDirectDisplayID = 2
    let enumerator = StubEnumerator(
        online: [stale, hotPlugged],
        builtinIDs: [stale],
        mainID: stale,
        boundsByID: [
            stale: CGRect(x: 0, y: 0, width: 1512, height: 982),
            hotPlugged: CGRect(x: 1512, y: 0, width: 1720, height: 1000),
        ],
        pixelWidths: [hotPlugged: 3440])

    // AppKit's cache only knows about the long-connected display.
    let screens = [
        snapshot(stale, name: "Built-in Retina Display", frame: CGRect(x: 0, y: 0, width: 1512, height: 982), visibleFrame: CGRect(x: 0, y: 0, width: 1512, height: 950), scale: 2)
    ]
    let result = SystemDisplayInventorySource.result(enumerator: enumerator, screens: screens)

    let known = try #require(result.value.first { $0.id == "display:uuid-1" })
    #expect(known.name == "Built-in Retina Display")
    // NSScreen visibleFrame (menu bar inset at the bottom of NS space) converts
    // to a 32pt top inset in canonical OS space.
    #expect(known.visibleFrame == .init(x: 0, y: 32, width: 1512, height: 950))
    #expect(known.backingScale == 2)

    let synthesized = try #require(result.value.first { $0.id == "display:uuid-2" })
    #expect(synthesized.name == "External Display")
    #expect(synthesized.visibleFrame == synthesized.frame)
    #expect(synthesized.backingScale == 2, "scale falls back to pixels/points")
}

@Test func cgInventoryEnrichesVisibleFrameOnDisplaysAbovePrimary() throws {
    let builtin: CGDirectDisplayID = 1
    let external: CGDirectDisplayID = 2
    let enumerator = StubEnumerator(
        online: [external, builtin],
        builtinIDs: [builtin],
        mainID: builtin,
        boundsByID: [
            builtin: CGRect(x: 0, y: 0, width: 1512, height: 982),
            external: CGRect(x: -1030, y: -1440, width: 3440, height: 1440),
        ],
        pixelWidths: [external: 3440])
    // AppKit knows both displays; the DELL sits above the builtin.
    let screens = [
        snapshot(builtin, name: "Built-in", frame: CGRect(x: 0, y: 0, width: 1512, height: 982), visibleFrame: CGRect(x: 0, y: 0, width: 1512, height: 950), scale: 2),
        snapshot(external, name: "DELL C3422WE", frame: CGRect(x: -1030, y: 982, width: 3440, height: 1440), visibleFrame: CGRect(x: -1030, y: 982, width: 3440, height: 1408), scale: 1),
    ]

    let result = SystemDisplayInventorySource.result(enumerator: enumerator, screens: screens)
    let dell = try #require(result.value.first { $0.id == "display:uuid-2" })
    #expect(dell.name == "DELL C3422WE")
    // Work area anchored at the DELL's OS-frame top edge (-1440), inset by its
    // 32pt menu bar.
    #expect(dell.frame == .init(x: -1030, y: -1440, width: 3440, height: 1440))
    #expect(dell.visibleFrame == .init(x: -1030, y: -1408, width: 3440, height: 1408))
}

@Test func nsScreenRectConversionUsesPrimaryTopAndOwnDisplayAnchors() {
    let primaryTop: CGFloat = 80
    // Primary's own visible frame: NS bottom-anchored (0,0,100,72) -> OS top-inset
    // (0,8,100,72).
    #expect(
      DisplayCoordinateConversion.nsScreenRectToOS(CGRect(x: 0, y: 0, width: 100, height: 72), primaryTop: primaryTop)
        == CGRect(x: 0, y: 8, width: 100, height: 72))
    // Display-relative: menu-bar inset rect at the bottom of NS space maps to a
    // top-inset rect in OS space.
    let converted = DisplayCoordinateConversion.nsScreenRectToOS(
      CGRect(x: -1030, y: 982, width: 3440, height: 1408),
      displayNSFrame: CGRect(x: -1030, y: 982, width: 3440, height: 1440),
      displayOSFrame: CGRect(x: -1030, y: -1440, width: 3440, height: 1440))
    #expect(converted == CGRect(x: -1030, y: -1408, width: 3440, height: 1408))
}

@Test func cgInventoryReportsUnhealthyWhenEnumerationFails() {
    let result = SystemDisplayInventorySource.result(enumerator: StubEnumerator(online: nil), screens: [])
    #expect(result.value.isEmpty)
    #expect(result.health.status == .unhealthy)
    #expect(result.health.issues.contains("CGGetOnlineDisplayList failed"))
}
