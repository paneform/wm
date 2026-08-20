import Foundation
import WMProtocol

public enum WindowCapabilityAdmission: Equatable, Sendable {
    case bsp, floating, unmanaged
}

public enum WindowCapabilityPolicy {
    public static func effective(_ capability: GeometryCapability) -> GeometryCapabilityState {
        switch capability.confirmed {
        case .supported, .fixed: capability.confirmed
        case .unknown, .inconclusive: capability.reported
        }
    }

    public static func admission(for capabilities: GeometryCapabilities) -> WindowCapabilityAdmission {
        let position = effective(capabilities.position)
        let size = effective(capabilities.size)
        if position == .fixed { return .unmanaged }
        if position == .supported && size == .fixed { return .floating }
        return .bsp
    }

    public static func merging(
        _ persisted: GeometryCapabilities, into current: GeometryCapabilities
    ) -> GeometryCapabilities {
        .init(
            position: merging(persisted.position, into: current.position),
            size: merging(persisted.size, into: current.size))
    }

    private static func merging(
        _ persisted: GeometryCapability, into current: GeometryCapability
    ) -> GeometryCapability {
        var merged = current
        if merged.confirmed == .unknown || merged.confirmed == .inconclusive {
            if persisted.confirmed == .supported || persisted.confirmed == .fixed {
                merged.confirmed = persisted.confirmed
            }
        }
        if merged.reported == .unknown || merged.reported == .inconclusive {
            merged.reported = persisted.reported
        }
        merged.evidence = Array(Set(merged.evidence + persisted.evidence)).sorted {
            if $0.source.rawValue != $1.source.rawValue { return $0.source.rawValue < $1.source.rawValue }
            return $0.state.rawValue < $1.state.rawValue
        }
        return merged
    }
}
