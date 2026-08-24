import AppKit
import CoreGraphics
import Foundation

/// CG-driven display inventory, ported from the ground-truth
/// `SystemDisplayInventorySource`. Enumeration is anchored on
/// `CGGetOnlineDisplayList` (fresh on every poll; AppKit's screen list is a
/// process-lifetime cache that never refreshes without an event loop).
/// Online-but-inactive displays (sleeping clamshell, mirrored-off) are
/// deliberately kept so topology reconciliation does not churn during sleep.
enum TopologySource {
    static func onlineDisplayList() -> [CGDirectDisplayID]? {
        var capacity: UInt32 = 8
        while true {
            var ids = [CGDirectDisplayID](repeating: 0, count: Int(capacity))
            var count: UInt32 = 0
            guard CGGetOnlineDisplayList(capacity, &ids, &count) == .success else { return nil }
            guard count > capacity else { return Array(ids.prefix(Int(count))) }
            capacity = count
        }
    }

    struct ScreenSnapshot {
        var displayID: CGDirectDisplayID
        var frame: CGRect
        var visibleFrame: CGRect
        var backingScale: CGFloat
    }

    @MainActor
    static func screenSnapshots() -> [CGDirectDisplayID: ScreenSnapshot] {
        var result: [CGDirectDisplayID: ScreenSnapshot] = [:]
        for screen in NSScreen.screens {
            guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else {
                continue
            }
            let displayID = number.uint32Value
            if result[displayID] == nil {
                result[displayID] = ScreenSnapshot(
                    displayID: displayID,
                    frame: screen.frame,
                    visibleFrame: screen.visibleFrame,
                    backingScale: screen.backingScaleFactor)
            }
        }
        return result
    }

    /// Builds the canonical display inventory. CG bounds pass through (already
    /// canonical); NSScreen work areas are converted once here, preserving each
    /// display's local vertical offset. AppKit fallbacks cover the hot-plug
    /// window where the cached screen list lacks a display.
    static func displays(
        online: [CGDirectDisplayID],
        screens: [CGDirectDisplayID: ScreenSnapshot]
    ) -> TopologyValue {
        let displays = online.map { displayID -> DisplayValue in
            // Display identity is stable across reconnects via UUID.
            let uuid = Self.uuidString(for: displayID)
            let id = uuid.map { "display:\($0.lowercased())" } ?? "display:\(displayID)"
            let frame = CoordinateConversion.cgBoundsToOS(CGDisplayBounds(displayID))
            let screen = screens[displayID]
            let workArea: Rect
            if let screen {
                workArea = CoordinateConversion.nsScreenRectToOS(
                    screen.visibleFrame,
                    displayNSFrame: screen.frame,
                    displayOSFrame: frame)
            } else {
                workArea = frame
            }
            let scale: Double
            if let screen {
                scale = Double(screen.backingScale)
            } else {
                let pixels = Int(CGDisplayPixelsWide(displayID))
                scale = pixels > 0 && frame.width > 0 ? Double(pixels) / frame.width : 1
            }
            return DisplayValue(
                id: id,
                frame: frame.frameValue,
                workArea: workArea.frameValue,
                scale: scale,
                primary: CGDisplayIsMain(displayID) != 0)
        }
        return TopologyValue(displays: Self.sorted(displays))
    }

    /// Primary first, then x, y, id.
    static func sorted(_ displays: [DisplayValue]) -> [DisplayValue] {
        displays.sorted { lhs, rhs in
            if lhs.primary != rhs.primary { return lhs.primary }
            if lhs.frame.x != rhs.frame.x { return lhs.frame.x < rhs.frame.x }
            if lhs.frame.y != rhs.frame.y { return lhs.frame.y < rhs.frame.y }
            return lhs.id < rhs.id
        }
    }

    private static func uuidString(for displayID: CGDirectDisplayID) -> String? {
        guard let value = CGDisplayCreateUUIDFromDisplayID(displayID)?.takeRetainedValue() else {
            return nil
        }
        return CFUUIDCreateString(nil, value) as String?
    }
}
