import Foundation

/// Canonical OS space: top-left origin of the primary display, y-axis down.
/// All observations crossing the wire are in this space.
struct Rect: Equatable, Sendable {
    var x: Double
    var y: Double
    var width: Double
    var height: Double

    var isUsable: Bool {
        x.isFinite && y.isFinite && width.isFinite && height.isFinite && width > 0 && height > 0
    }

    func approximatelyEquals(_ other: Rect, tolerance: Double = 2) -> Bool {
        abs(x - other.x) <= tolerance && abs(y - other.y) <= tolerance
            && abs(width - other.width) <= tolerance && abs(height - other.height) <= tolerance
    }
}

extension Rect {
    init(_ value: FrameValue) {
        self.init(x: value.x, y: value.y, width: value.width, height: value.height)
    }

    var frameValue: FrameValue {
        FrameValue(x: x, y: y, width: width, height: height)
    }

    init?(_ dictionary: [String: Any]) {
        func number(_ key: String) -> Double? {
            (dictionary[key] as? NSNumber)?.doubleValue
        }
        guard let x = number("X"), let y = number("Y"),
              let width = number("Width"), let height = number("Height") else { return nil }
        self.init(x: x, y: y, width: width, height: height)
    }
}

enum CoordinateConversion {
    /// `CGDisplayBounds` already uses canonical OS space: top-left origin of
    /// the primary display, y-down — identical to AX global coordinates.
    static func cgBoundsToOS(_ bounds: CGRect) -> Rect {
        Rect(x: bounds.origin.x, y: bounds.origin.y, width: bounds.width, height: bounds.height)
    }

    /// Converts an NSScreen-space rect (bottom-left origin, y-up, primary
    /// bottom at y=0) into canonical OS space given the primary display's top
    /// edge in NSScreen space.
    static func nsScreenRectToOS(_ rect: CGRect, primaryTop: CGFloat) -> Rect {
        Rect(
            x: rect.origin.x,
            y: Double(primaryTop - rect.maxY),
            width: Double(rect.width),
            height: Double(rect.height))
    }

    /// Converts an NSScreen-space rect belonging to a specific display into
    /// canonical OS space. Horizontal position is shared; vertical position is
    /// preserved relative to the display's own frame and re-anchored at the
    /// display's canonical top edge.
    static func nsScreenRectToOS(_ rect: CGRect, displayNSFrame: CGRect, displayOSFrame: Rect) -> Rect {
        let localTopOffset = displayNSFrame.height - (rect.maxY - displayNSFrame.minY)
        return Rect(
            x: rect.minX,
            y: displayOSFrame.y + localTopOffset,
            width: rect.width,
            height: rect.height)
    }
}
