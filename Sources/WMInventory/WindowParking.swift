import Foundation
import WMDiagnostics

public enum ParkingCorner: String, CaseIterable, Codable, Sendable {
  case bottomLeft, bottomRight, topLeft, topRight
}

public struct WindowParkingPlan: Sendable {
  public let corner: ParkingCorner
  public let displayFrame: InventoryRect
  public let targetFrame: InventoryRect
  public let limits: ParkingVisibility
  public let provenance: DiagnosticProvenance

  public init?(
    displayFrame: InventoryRect, otherDisplayFrames: [InventoryRect], windowFrame: InventoryRect,
    diagnosis: ResolvedDiagnostic<ParkingLimits>
  ) {
    guard
      let corner = Self.availableCorners(
        on: displayFrame, avoiding: otherDisplayFrames, window: windowFrame
      ).first
    else { return nil }
    guard let limits = diagnosis.value.corners[corner] else { return nil }
    self.corner = corner
    self.displayFrame = displayFrame
    self.limits = limits
    provenance = diagnosis.provenance
    targetFrame = Self.target(
      for: corner, display: displayFrame, window: windowFrame, limits: limits)
  }

  public static func alternatives(
    displayFrame: InventoryRect, otherDisplayFrames: [InventoryRect], windowFrame: InventoryRect,
    diagnosis: ResolvedDiagnostic<ParkingLimits>
  ) -> [Self] {
    availableCorners(on: displayFrame, avoiding: otherDisplayFrames, window: windowFrame).compactMap
    {
      guard let limits = diagnosis.value.corners[$0] else { return nil }
      return Self(
        corner: $0, displayFrame: displayFrame,
        targetFrame: target(for: $0, display: displayFrame, window: windowFrame, limits: limits),
        limits: limits, provenance: diagnosis.provenance)
    }
  }

  private init(
    corner: ParkingCorner, displayFrame: InventoryRect, targetFrame: InventoryRect,
    limits: ParkingVisibility, provenance: DiagnosticProvenance
  ) {
    self.corner = corner
    self.displayFrame = displayFrame
    self.targetFrame = targetFrame
    self.limits = limits
    self.provenance = provenance
  }

  public func accepts(_ observed: InventoryRect, tolerance: Double = 1) -> Bool {
    guard abs(observed.width - targetFrame.width) <= tolerance,
      abs(observed.height - targetFrame.height) <= tolerance
    else { return false }
    switch corner {
    case .bottomLeft:
      return observed.maxX <= displayFrame.x + limits.horizontal + tolerance
        && observed.y >= displayFrame.maxY - limits.vertical - tolerance
    case .bottomRight:
      return observed.x >= displayFrame.maxX - limits.horizontal - tolerance
        && observed.y >= displayFrame.maxY - limits.vertical - tolerance
    case .topLeft:
      return observed.maxX <= displayFrame.x + limits.horizontal + tolerance
        && observed.maxY <= displayFrame.y + limits.vertical + tolerance
    case .topRight:
      return observed.x >= displayFrame.maxX - limits.horizontal - tolerance
        && observed.maxY <= displayFrame.y + limits.vertical + tolerance
    }
  }

  public static func availableCorners(
    on display: InventoryRect, avoiding others: [InventoryRect], window: InventoryRect
  ) -> [ParkingCorner] {
    ParkingCorner.allCases.filter { corner in
      !others.contains {
        $0.intersects(clampedFrame(for: corner, display: display, window: window))
      }
    }
  }

  private static func clampedFrame(
    for corner: ParkingCorner, display: InventoryRect, window: InventoryRect
  ) -> InventoryRect {
    target(for: corner, display: display, window: window, limits: .init(horizontal: 1, vertical: 1))
  }

  public static func target(
    for corner: ParkingCorner, display: InventoryRect, window: InventoryRect,
    limits: ParkingVisibility
  ) -> InventoryRect {
    let x =
      switch corner {
      case .bottomLeft, .topLeft: display.x - window.width + limits.horizontal
      case .bottomRight, .topRight: display.maxX - limits.horizontal
      }
    let y =
      switch corner {
      case .topLeft, .topRight: display.y - window.height + limits.vertical
      case .bottomLeft, .bottomRight: display.maxY - limits.vertical
      }
    return InventoryRect(x: x, y: y, width: window.width, height: window.height)
  }

  public static func visibleAnchor(
    for corner: ParkingCorner, display: InventoryRect, window: InventoryRect
  ) -> InventoryRect {
    let x =
      switch corner {
      case .bottomLeft, .topLeft: display.x
      case .bottomRight, .topRight: display.maxX - window.width
      }
    let y =
      switch corner {
      case .topLeft, .topRight: display.y
      case .bottomLeft, .bottomRight: display.maxY - window.height
      }
    return .init(x: x, y: y, width: window.width, height: window.height)
  }

  public static func offscreenEndpoint(
    for corner: ParkingCorner, display: InventoryRect, window: InventoryRect
  ) -> InventoryRect {
    target(
      for: corner, display: display, window: window,
      limits: .init(horizontal: 0, vertical: 0))
  }

  public static func axisTarget(
    from anchor: InventoryRect, to endpoint: InventoryRect, horizontal: Bool, progress: Int
  ) -> InventoryRect {
    let start = horizontal ? anchor.x : anchor.y
    let end = horizontal ? endpoint.x : endpoint.y
    let coordinate = start + Double(progress) * (end >= start ? 1 : -1)
    return .init(
      x: horizontal ? coordinate : anchor.x,
      y: horizontal ? anchor.y : coordinate,
      width: anchor.width, height: anchor.height)
  }

  public static func axisDirection(
    from anchor: InventoryRect, to endpoint: InventoryRect, horizontal: Bool
  ) -> Double {
    let start = horizontal ? anchor.x : anchor.y
    let end = horizontal ? endpoint.x : endpoint.y
    return end >= start ? 1 : -1
  }

  public static func visibility(
    for corner: ParkingCorner, display: InventoryRect, accepted: InventoryRect
  ) -> ParkingVisibility {
    let horizontal =
      switch corner {
      case .bottomLeft, .topLeft: accepted.maxX - display.x
      case .bottomRight, .topRight: display.maxX - accepted.x
      }
    let vertical =
      switch corner {
      case .topLeft, .topRight: accepted.maxY - display.y
      case .bottomLeft, .bottomRight: display.maxY - accepted.y
      }
    return .init(horizontal: max(0, horizontal), vertical: max(0, vertical))
  }
}

extension InventoryRect {
  fileprivate var maxX: Double { x + width }
  fileprivate var maxY: Double { y + height }

  fileprivate func intersects(_ other: Self) -> Bool {
    x < other.maxX && maxX > other.x && y < other.maxY && maxY > other.y
  }
}

public func axDisplayFrames(_ displays: [DisplayObservation]) -> [String: InventoryRect] {
  DisplayTopologySnapshot(displays: displays).axFrames
}

public func isCenteredOnDisplay(_ frame: InventoryRect, displays: [InventoryRect]) -> Bool {
  let center = (x: frame.x + frame.width / 2, y: frame.y + frame.height / 2)
  return displays.contains {
    center.x >= $0.x && center.x < $0.maxX && center.y >= $0.y && center.y < $0.maxY
  }
}
