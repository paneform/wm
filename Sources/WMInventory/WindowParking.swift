import Foundation

public enum ParkingCorner: CaseIterable, Sendable {
    case bottomLeft, bottomRight, topLeft, topRight
}

public struct WindowParkingPlan: Sendable {
    public let corner: ParkingCorner
    public let displayFrame: InventoryRect
    public let targetFrame: InventoryRect

    public init?(displayFrame: InventoryRect, otherDisplayFrames: [InventoryRect], windowFrame: InventoryRect) {
        guard let corner = Self.availableCorners(on: displayFrame, avoiding: otherDisplayFrames, window: windowFrame).first else { return nil }
        self.corner = corner
        self.displayFrame = displayFrame
        targetFrame = Self.target(for: corner, display: displayFrame, window: windowFrame)
    }

    public static func alternatives(
        displayFrame: InventoryRect, otherDisplayFrames: [InventoryRect], windowFrame: InventoryRect
    ) -> [Self] {
        availableCorners(on: displayFrame, avoiding: otherDisplayFrames, window: windowFrame).map {
            Self(corner: $0, displayFrame: displayFrame, targetFrame: target(for: $0, display: displayFrame, window: windowFrame))
        }
    }

    private init(corner: ParkingCorner, displayFrame: InventoryRect, targetFrame: InventoryRect) {
        self.corner = corner
        self.displayFrame = displayFrame
        self.targetFrame = targetFrame
    }

    public func accepts(_ observed: InventoryRect, tolerance: Double = 40) -> Bool {
        guard abs(observed.width - targetFrame.width) <= tolerance,
              abs(observed.height - targetFrame.height) <= tolerance else { return false }
        switch corner {
        case .bottomLeft:
            return observed.maxX <= displayFrame.x + 1 + tolerance && observed.y >= displayFrame.maxY - 52 - tolerance
        case .bottomRight:
            return observed.x >= displayFrame.maxX - 1 - tolerance && observed.y >= displayFrame.maxY - 52 - tolerance
        case .topLeft:
            return observed.maxX <= displayFrame.x + 1 + tolerance && observed.maxY <= displayFrame.y + 52 + tolerance
        case .topRight:
            return observed.x >= displayFrame.maxX - 1 - tolerance && observed.maxY <= displayFrame.y + 52 + tolerance
        }
    }

    private static func availableCorners(on display: InventoryRect, avoiding others: [InventoryRect], window: InventoryRect) -> [ParkingCorner] {
        ParkingCorner.allCases.filter { corner in
            !others.contains { $0.intersects(clampedFrame(for: corner, display: display, window: window)) }
        }
    }

    private static func clampedFrame(for corner: ParkingCorner, display: InventoryRect, window: InventoryRect) -> InventoryRect {
        target(for: corner, display: display, window: window)
    }

    private static func target(for corner: ParkingCorner, display: InventoryRect, window: InventoryRect) -> InventoryRect {
        let x = switch corner {
        case .bottomLeft, .topLeft: display.x - window.width + 1
        case .bottomRight, .topRight: display.maxX - 1
        }
        let y = switch corner {
        case .topLeft, .topRight: display.y - window.height + 52
        case .bottomLeft, .bottomRight: display.maxY - 52
        }
        return InventoryRect(x: x, y: y, width: window.width, height: window.height)
    }
}

private extension InventoryRect {
    var maxX: Double { x + width }
    var maxY: Double { y + height }

    func intersects(_ other: Self) -> Bool {
        x < other.maxX && maxX > other.x && y < other.maxY && maxY > other.y
    }
}

public func axDisplayFrames(_ displays: [DisplayObservation]) -> [String: InventoryRect] {
    DisplayTopologySnapshot(displays: displays).axFrames
}

public func isCenteredOnDisplay(_ frame: InventoryRect, displays: [InventoryRect]) -> Bool {
    let center = (x: frame.x + frame.width / 2, y: frame.y + frame.height / 2)
    return displays.contains { center.x >= $0.x && center.x < $0.maxX && center.y >= $0.y && center.y < $0.maxY }
}
