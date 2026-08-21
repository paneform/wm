import Foundation
import WMDiagnostics

#if canImport(CryptoKit)
  import CryptoKit
#endif

public struct ParkingVisibility: Codable, Equatable, Sendable {
  public var horizontal: Double
  public var vertical: Double

  public init(horizontal: Double, vertical: Double) {
    self.horizontal = horizontal
    self.vertical = vertical
  }
}

public struct ParkingLimits: Codable, Equatable, Sendable {
  public var corners: [ParkingCorner: ParkingVisibility]

  public init(corners: [ParkingCorner: ParkingVisibility]) { self.corners = corners }
}

public enum ParkingDiagnosticError: Error, Equatable {
  case noAcceptedPosition
  case noTopologySafeCorner
  case unstableBoundary
  case inconclusiveObservation
}

public struct ParkingAxisBounds: Equatable, Sendable {
  public var acceptedCoordinate: Double
  public var rejectedCoordinate: Double
  public var direction: Double
  public var distance: Int

  public func coordinate(at progress: Int) -> Double {
    acceptedCoordinate + Double(progress) * direction
  }
}

public struct ParkingLimitDiscovery: Sendable {
  public init() {}

  public func boundsIfClamped(
    observed: Double, endpoint: Double, direction: Double, acceptedSeed: Double? = nil
  ) throws -> ParkingAxisBounds? {
    guard observed != endpoint else { return nil }
    return try clampedAxisBounds(
      observed: observed, endpoint: endpoint, direction: direction,
      acceptedSeed: acceptedSeed)
  }

  public func clampedAxisBounds(
    observed: Double, endpoint: Double, direction: Double, acceptedSeed: Double? = nil
  ) throws -> ParkingAxisBounds {
    guard direction == -1 || direction == 1 else {
      throw ParkingDiagnosticError.inconclusiveObservation
    }
    func safeInteger(_ value: Double) -> Double {
      direction > 0 ? value.rounded(.down) : value.rounded(.up)
    }
    let observedAccepted = safeInteger(observed)
    let accepted = [observedAccepted, acceptedSeed.map(safeInteger)].compactMap { $0 }.max {
      ($0 - observedAccepted) * direction < ($1 - observedAccepted) * direction
    }!
    let rejected = endpoint - direction
    let distance = Int(((rejected - accepted) * direction).rounded())
    guard distance >= 0 else { throw ParkingDiagnosticError.inconclusiveObservation }
    return .init(
      acceptedCoordinate: accepted, rejectedCoordinate: rejected,
      direction: direction, distance: distance)
  }

}

struct ParkingJointAxisSearch: Sendable {
  let bounds: ParkingAxisBounds
  var acceptedProgress: Int
  var rejectedProgress: Int
  var testedAdjacent: Bool

  init(bounds: ParkingAxisBounds) {
    self.bounds = bounds
    acceptedProgress = 0
    rejectedProgress = bounds.distance
    testedAdjacent = false
  }

  var isComplete: Bool { rejectedProgress <= acceptedProgress }

  func coordinate(at progress: Int) -> Double { bounds.coordinate(at: progress) }

  /// First probe tests exactly one point past the accepted clamp; afterwards binary search over
  /// the inclusive remaining interval, so the upper bound itself is tested before convergence.
  func nextProgress() -> Int {
    guard !isComplete else { return acceptedProgress }
    if !testedAdjacent { return min(acceptedProgress + 1, rejectedProgress) }
    return acceptedProgress + (rejectedProgress - acceptedProgress + 1) / 2
  }

  static func safeInteger(_ value: Double, direction: Double) -> Double {
    direction > 0 ? value.rounded(.down) : value.rounded(.up)
  }

  mutating func update(requested: Int, observed: Double) {
    if observed == coordinate(at: requested) {
      acceptedProgress = max(acceptedProgress, requested)
      return
    }
    rejectedProgress = min(rejectedProgress, requested - 1)
    let tightened =
      Int(((Self.safeInteger(observed, direction: bounds.direction) - bounds.acceptedCoordinate)
        * bounds.direction).rounded())
    if tightened > acceptedProgress, tightened < requested { acceptedProgress = tightened }
  }
}

public enum ParkingJointDiscovery {
  /// Searches clamped axes simultaneously with shared probes. Every probe requests one combined
  /// frame; each response updates each axis independently, so one clamped axis never fails the
  /// other. A nil axis was retained at its endpoint during the initial corner request and holds
  /// that endpoint coordinate throughout. The winning combined frame is re-probed once for joint
  /// retention before results are returned.
  public static func search(
    base: InventoryRect, xAxis: ParkingAxisBounds?, yAxis: ParkingAxisBounds?,
    observe: @escaping @Sendable (InventoryRect) async throws -> InventoryRect
  ) async throws -> (x: Double?, y: Double?) {
    var x = xAxis.map(ParkingJointAxisSearch.init)
    var y = yAxis.map(ParkingJointAxisSearch.init)
    let maximumDistance = max(x?.bounds.distance ?? 0, y?.bounds.distance ?? 0, 1)
    let maximumProbes = 2 * (Int(ceil(log2(Double(maximumDistance)))) + 3) + 2

    var probes = 0
    while !(x?.isComplete ?? true) || !(y?.isComplete ?? true) {
      probes += 1
      guard probes <= maximumProbes else { throw ParkingDiagnosticError.unstableBoundary }
      var target = base
      var xRequested: Int?
      var yRequested: Int?
      if var axis = x {
        let progress = axis.nextProgress()
        axis.testedAdjacent = true
        x = axis
        xRequested = progress
        target.x = axis.coordinate(at: progress)
      }
      if var axis = y {
        let progress = axis.nextProgress()
        axis.testedAdjacent = true
        y = axis
        yRequested = progress
        target.y = axis.coordinate(at: progress)
      }
      let observed = try await observe(target)
      if let requested = xRequested { x?.update(requested: requested, observed: observed.x) }
      if let requested = yRequested { y?.update(requested: requested, observed: observed.y) }
    }

    var result = base
    if let x { result.x = x.coordinate(at: x.acceptedProgress) }
    if let y { result.y = y.coordinate(at: y.acceptedProgress) }
    let verified = try await observe(result)
    let xMatches = x == nil ? verified.x == base.x : verified.x == result.x
    let yMatches = y == nil ? verified.y == base.y : verified.y == result.y
    guard xMatches, yMatches else { throw ParkingDiagnosticError.unstableBoundary }
    return (x: x.map { _ in result.x }, y: y.map { _ in result.y })
  }
}

public enum ParkingDiagnosticIdentity {
  public static let id = "parking-limits"
  public static let revision = 6

  public static func key(
    displayID: String, displays: [DisplayObservation], operatingSystem: OperatingSystemVersion
  )
    throws -> DiagnosticKey
  {
    struct DisplayCondition: Codable {
      var id: String
      var isBuiltin: Bool
      var isPrimary: Bool
      var frame: InventoryRect
      var visibleFrame: InventoryRect
      var backingScale: Double
    }
    struct Conditions: Codable {
      var operatingSystem: [Int]
      var displayID: String
      var displays: [DisplayCondition]
    }
    let conditions = Conditions(
      operatingSystem: [
        operatingSystem.majorVersion, operatingSystem.minorVersion,
        operatingSystem.patchVersion,
      ],
      displayID: displayID,
      displays: displays.sorted { $0.id < $1.id }.map {
        .init(
          id: $0.id, isBuiltin: $0.isBuiltin, isPrimary: $0.isPrimary, frame: $0.frame,
          visibleFrame: $0.visibleFrame, backingScale: $0.backingScale)
      })
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let encoded = try encoder.encode(conditions)
    #if canImport(CryptoKit)
      let fingerprint = SHA256.hash(data: encoded).map { String(format: "%02x", $0) }.joined()
    #else
      let fingerprint = encoded.base64EncodedString()
    #endif
    return .init(
      id: id, revision: revision,
      fingerprint: fingerprint)
  }
}
