import Foundation
import WMDiagnostics

public enum ParkingCorner: String, CaseIterable, Codable, Sendable {
  case bottomLeft, bottomRight, topLeft, topRight
}

public struct WindowParkingPlan: Sendable {
  public let corner: ParkingCorner
  public let displayFrame: InventoryRect
  public let otherDisplayFrames: [InventoryRect]
  public let targetFrame: InventoryRect
  public let limits: ParkingVisibility
  public let provenance: DiagnosticProvenance

  public init?(
    displayFrame: InventoryRect, otherDisplayFrames: [InventoryRect], windowFrame: InventoryRect,
    diagnosis: ResolvedDiagnostic<ParkingLimits>
  ) {
    guard
      let plan = Self.alternatives(
        displayFrame: displayFrame, otherDisplayFrames: otherDisplayFrames,
        windowFrame: windowFrame, diagnosis: diagnosis
      ).first
    else { return nil }
    self = plan
  }

  public static func alternatives(
    displayFrame: InventoryRect, otherDisplayFrames: [InventoryRect], windowFrame: InventoryRect,
    diagnosis: ResolvedDiagnostic<ParkingLimits>
  ) -> [Self] {
    ParkingCorner.allCases.compactMap { corner in
      guard let limits = diagnosis.value.corners[corner] else { return nil }
      let targetFrame = target(
        for: corner, display: displayFrame, window: windowFrame, limits: limits)
      guard !otherDisplayFrames.contains(where: { $0.intersects(targetFrame) }) else { return nil }
      return Self(
        corner: corner, displayFrame: displayFrame, otherDisplayFrames: otherDisplayFrames,
        targetFrame: targetFrame,
        limits: limits, provenance: diagnosis.provenance)
    }
  }

  private init(
    corner: ParkingCorner, displayFrame: InventoryRect, otherDisplayFrames: [InventoryRect],
    targetFrame: InventoryRect, limits: ParkingVisibility, provenance: DiagnosticProvenance
  ) {
    self.corner = corner
    self.displayFrame = displayFrame
    self.otherDisplayFrames = otherDisplayFrames
    self.targetFrame = targetFrame
    self.limits = limits
    self.provenance = provenance
  }

  public func accepts(_ observed: InventoryRect, tolerance: Double = 1) -> Bool {
    guard abs(observed.width - targetFrame.width) <= tolerance,
      abs(observed.height - targetFrame.height) <= tolerance,
      !otherDisplayFrames.contains(where: { $0.intersects(observed) })
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
    on display: InventoryRect, avoiding others: [InventoryRect], window: InventoryRect,
    currentFrame: InventoryRect? = nil
  ) -> [ParkingCorner] {
    ParkingCorner.allCases.filter { corner in
      let anchor = diagnosticStart(
        for: corner, display: display, window: window, currentFrame: currentFrame,
        avoiding: others)
      let endpoint = offscreenEndpoint(for: corner, display: display, window: window)
      return isTopologySafe(sweptRegion(from: anchor, to: endpoint), avoiding: others)
    }
  }

  public static func diagnosticStart(
    for corner: ParkingCorner, display: InventoryRect, window: InventoryRect,
    currentFrame: InventoryRect?, avoiding others: [InventoryRect]
  ) -> InventoryRect {
    let anchor = visibleAnchor(for: corner, display: display, window: window)
    guard let currentFrame,
      abs(currentFrame.width - window.width) <= 1,
      abs(currentFrame.height - window.height) <= 1,
      isTopologySafe(currentFrame, avoiding: others)
    else { return anchor }
    let endpoint = offscreenEndpoint(for: corner, display: display, window: window)
    var result = anchor
    if isAxisSeed(currentFrame.x, from: anchor.x, to: endpoint.x) { result.x = currentFrame.x }
    if isAxisSeed(currentFrame.y, from: anchor.y, to: endpoint.y) { result.y = currentFrame.y }
    return isTopologySafe(result, avoiding: others) ? result : anchor
  }

  public static func isTopologySafe(
    _ frame: InventoryRect, avoiding others: [InventoryRect]
  ) -> Bool {
    !others.contains { $0.intersects(frame) }
  }

  public static func isAxisSeed(_ coordinate: Double, from anchor: Double, to endpoint: Double)
    -> Bool
  {
    let range = min(anchor, endpoint)...max(anchor, endpoint)
    return range.contains(coordinate)
  }

  private static func sweptRegion(from start: InventoryRect, to endpoint: InventoryRect)
    -> InventoryRect
  {
    .init(
      x: min(start.x, endpoint.x), y: min(start.y, endpoint.y),
      width: abs(endpoint.x - start.x) + start.width,
      height: abs(endpoint.y - start.y) + start.height)
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
