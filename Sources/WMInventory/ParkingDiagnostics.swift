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

  public func maximumAcceptedProgress(
    distance: Int,
    accepts: @escaping @Sendable (Int) async throws -> Bool
  ) async throws -> Int {
    guard distance >= 0, try await accepts(0) else {
      throw ParkingDiagnosticError.noAcceptedPosition
    }
    if distance == 0 { return 0 }
    if try await accepts(distance) { return distance }
    var accepted = 0
    var rejected = distance
    while rejected - accepted > 1 {
      let midpoint = accepted + (rejected - accepted) / 2
      if try await accepts(midpoint) { accepted = midpoint } else { rejected = midpoint }
    }
    guard try await accepts(accepted) else { throw ParkingDiagnosticError.unstableBoundary }
    return accepted
  }

  public func furthestRetainedCoordinate(
    bounds: ParkingAxisBounds, tolerance: Double = 0,
    observe: @escaping @Sendable (Double) async throws -> Double
  ) async throws -> Double {
    let progress = try await maximumAcceptedProgress(distance: bounds.distance) { progress in
      let requested = bounds.coordinate(at: progress)
      let observed = try await observe(requested)
      return abs(observed - requested) <= tolerance
    }
    let requested = bounds.coordinate(at: progress)
    let observed = try await observe(requested)
    guard abs(observed - requested) <= tolerance else {
      throw ParkingDiagnosticError.unstableBoundary
    }
    return bounds.direction > 0 ? min(requested, observed) : max(requested, observed)
  }
}

public enum ParkingDiagnosticIdentity {
  public static let id = "parking-limits"
  public static let revision = 5

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
