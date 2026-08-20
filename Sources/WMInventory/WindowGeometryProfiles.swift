import Foundation
import WMProtocol

public struct WindowGeometryProfileIdentity: Codable, Hashable, Sendable {
    public var application: String
    public var role: String?
    public var subrole: String?

    public init?(window: NormalizedWindow) {
        guard let application = window.bundleID ?? window.executablePath else { return nil }
        self.application = application
        self.role = window.role
        self.subrole = window.subrole
    }
}

public struct WindowGeometryProfileContext: Codable, Hashable, Sendable {
    public var applicationVersion: String?
    public var topologyFingerprint: String?

    public init(applicationVersion: String? = nil, topologyFingerprint: String? = nil) {
        self.applicationVersion = applicationVersion
        self.topologyFingerprint = topologyFingerprint
    }
}

public enum WindowGeometryProfileConfidence: String, Codable, Sendable { case tentative, learned, strong }

public enum WindowGeometryLearningMode: String, Codable, Sendable {
    case storeAndReuse
    case inferEveryRequest
    case optimisticIdealFirst
}

public struct WindowGeometryRetryPolicy: Equatable, Sendable {
    public var maximumAttempts: Int
    public var mode: WindowGeometryLearningMode

    public init(maximumAttempts: Int = 5, mode: WindowGeometryLearningMode = .storeAndReuse) {
        self.maximumAttempts = maximumAttempts
        self.mode = mode
    }
}

public struct WindowGeometryProfile: Codable, Equatable, Sendable {
    public var identity: WindowGeometryProfileIdentity
    public var context: WindowGeometryProfileContext
    public var minimumWidth: Double?
    public var minimumHeight: Double?
    public var maximumWidth: Double?
    public var maximumHeight: Double?
    public var correctiveAttemptCount: Int
    public var sampleCount: Int
    public var successfulSampleCount: Int
    public var lastObservedAt: Date
    public var pendingMinimumWidth: Double?
    public var pendingMinimumWidthSamples: Int
    public var pendingMinimumHeight: Double?
    public var pendingMinimumHeightSamples: Int
    public var pendingMaximumWidth: Double?
    public var pendingMaximumWidthSamples: Int
    public var pendingMaximumHeight: Double?
    public var pendingMaximumHeightSamples: Int
    public var geometryCapabilities: GeometryCapabilities

    enum CodingKeys: String, CodingKey {
        case identity, context, minimumWidth, minimumHeight, maximumWidth, maximumHeight
        case correctiveAttemptCount, sampleCount, successfulSampleCount, lastObservedAt
        case pendingMinimumWidth, pendingMinimumWidthSamples, pendingMinimumHeight, pendingMinimumHeightSamples
        case pendingMaximumWidth, pendingMaximumWidthSamples, pendingMaximumHeight, pendingMaximumHeightSamples
        case geometryCapabilities
    }

    public init(
        identity: WindowGeometryProfileIdentity, context: WindowGeometryProfileContext,
        minimumWidth: Double? = nil, minimumHeight: Double? = nil,
        maximumWidth: Double? = nil, maximumHeight: Double? = nil,
        correctiveAttemptCount: Int, sampleCount: Int, successfulSampleCount: Int,
        lastObservedAt: Date, pendingMinimumWidth: Double? = nil, pendingMinimumWidthSamples: Int = 0,
        pendingMinimumHeight: Double? = nil, pendingMinimumHeightSamples: Int = 0,
        pendingMaximumWidth: Double? = nil, pendingMaximumWidthSamples: Int = 0,
        pendingMaximumHeight: Double? = nil, pendingMaximumHeightSamples: Int = 0,
        geometryCapabilities: GeometryCapabilities = .init()
    ) {
        self.identity = identity
        self.context = context
        self.minimumWidth = minimumWidth
        self.minimumHeight = minimumHeight
        self.maximumWidth = maximumWidth
        self.maximumHeight = maximumHeight
        self.correctiveAttemptCount = correctiveAttemptCount
        self.sampleCount = sampleCount
        self.successfulSampleCount = successfulSampleCount
        self.lastObservedAt = lastObservedAt
        self.pendingMinimumWidth = pendingMinimumWidth
        self.pendingMinimumWidthSamples = pendingMinimumWidthSamples
        self.pendingMinimumHeight = pendingMinimumHeight
        self.pendingMinimumHeightSamples = pendingMinimumHeightSamples
        self.pendingMaximumWidth = pendingMaximumWidth
        self.pendingMaximumWidthSamples = pendingMaximumWidthSamples
        self.pendingMaximumHeight = pendingMaximumHeight
        self.pendingMaximumHeightSamples = pendingMaximumHeightSamples
        self.geometryCapabilities = geometryCapabilities
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            identity: try values.decode(WindowGeometryProfileIdentity.self, forKey: .identity),
            context: try values.decode(WindowGeometryProfileContext.self, forKey: .context),
            minimumWidth: try values.decodeIfPresent(Double.self, forKey: .minimumWidth),
            minimumHeight: try values.decodeIfPresent(Double.self, forKey: .minimumHeight),
            maximumWidth: try values.decodeIfPresent(Double.self, forKey: .maximumWidth),
            maximumHeight: try values.decodeIfPresent(Double.self, forKey: .maximumHeight),
            correctiveAttemptCount: try values.decode(Int.self, forKey: .correctiveAttemptCount),
            sampleCount: try values.decode(Int.self, forKey: .sampleCount),
            successfulSampleCount: try values.decode(Int.self, forKey: .successfulSampleCount),
            lastObservedAt: try values.decode(Date.self, forKey: .lastObservedAt),
            pendingMinimumWidth: try values.decodeIfPresent(Double.self, forKey: .pendingMinimumWidth),
            pendingMinimumWidthSamples: try values.decodeIfPresent(Int.self, forKey: .pendingMinimumWidthSamples) ?? 0,
            pendingMinimumHeight: try values.decodeIfPresent(Double.self, forKey: .pendingMinimumHeight),
            pendingMinimumHeightSamples: try values.decodeIfPresent(Int.self, forKey: .pendingMinimumHeightSamples) ?? 0,
            pendingMaximumWidth: try values.decodeIfPresent(Double.self, forKey: .pendingMaximumWidth),
            pendingMaximumWidthSamples: try values.decodeIfPresent(Int.self, forKey: .pendingMaximumWidthSamples) ?? 0,
            pendingMaximumHeight: try values.decodeIfPresent(Double.self, forKey: .pendingMaximumHeight),
            pendingMaximumHeightSamples: try values.decodeIfPresent(Int.self, forKey: .pendingMaximumHeightSamples) ?? 0,
            geometryCapabilities: try values.decodeIfPresent(GeometryCapabilities.self, forKey: .geometryCapabilities) ?? .init())
    }

    public var confidence: WindowGeometryProfileConfidence {
        sampleCount >= 8 ? .strong : sampleCount >= 3 ? .learned : .tentative
    }
}

public struct WindowGeometryProfileCatalog: Codable, Equatable, Sendable {
    public var profiles: [WindowGeometryProfile]
    public init(profiles: [WindowGeometryProfile] = []) { self.profiles = profiles }
}

public struct WindowGeometryObservation: Sendable {
    public var window: NormalizedWindow
    public var context: WindowGeometryProfileContext
    public var requested: InventoryRect
    public var observed: InventoryRect
    public var attempts: Int
    public var outcome: WindowGeometryAttemptOutcome
    public var stableClamp: Bool
    public var observedAt: Date

    public init(
        window: NormalizedWindow, context: WindowGeometryProfileContext,
        requested: InventoryRect, observed: InventoryRect, attempts: Int,
        outcome: WindowGeometryAttemptOutcome, stableClamp: Bool = false,
        observedAt: Date
    ) {
        self.window = window
        self.context = context
        self.requested = requested
        self.observed = observed
        self.attempts = attempts
        self.outcome = outcome
        self.stableClamp = stableClamp
        self.observedAt = observedAt
    }
}

public enum WindowGeometryAttemptOutcome: String, Codable, Equatable, Sendable {
    case exact
    case constrained
    case progressing
    case failed
}

public protocol WindowGeometryProfilePersisting: Sendable {
    func save(_ catalog: WindowGeometryProfileCatalog) throws
}

public actor WindowGeometryProfileRecorder {
    private var catalog: WindowGeometryProfileCatalog
    private let persistence: (any WindowGeometryProfilePersisting)?

    public init(
        catalog: WindowGeometryProfileCatalog = .init(),
        persistence: (any WindowGeometryProfilePersisting)? = nil
    ) {
        self.catalog = catalog
        self.persistence = persistence
    }

    public func record(_ observation: WindowGeometryObservation) throws {
        guard let identity = WindowGeometryProfileIdentity(window: observation.window) else { return }
        let index = catalog.profiles.firstIndex {
            $0.identity == identity && $0.context == observation.context
        }
        var profile = index.map { catalog.profiles[$0] } ?? WindowGeometryProfile(
            identity: identity, context: observation.context, minimumWidth: nil, minimumHeight: nil,
            correctiveAttemptCount: 1, sampleCount: 0, successfulSampleCount: 0,
            lastObservedAt: observation.observedAt
        )
        profile.sampleCount += 1
        let successful = observation.outcome == .exact || observation.outcome == .constrained
        profile.successfulSampleCount += successful ? 1 : 0
        if successful {
            profile.correctiveAttemptCount = max(profile.correctiveAttemptCount, observation.attempts)
        }
        profile.lastObservedAt = observation.observedAt
        if observation.outcome == .constrained || observation.stableClamp {
            if observation.observed.width > observation.requested.width {
                updateMinimum(
                    observation.observed.width, pending: &profile.pendingMinimumWidth,
                    samples: &profile.pendingMinimumWidthSamples, learned: &profile.minimumWidth
                )
            }
            if observation.observed.height > observation.requested.height {
                updateMinimum(
                    observation.observed.height, pending: &profile.pendingMinimumHeight,
                    samples: &profile.pendingMinimumHeightSamples, learned: &profile.minimumHeight
                )
            }
            if observation.observed.width < observation.requested.width {
                updateMaximum(
                    observation.observed.width, pending: &profile.pendingMaximumWidth,
                    samples: &profile.pendingMaximumWidthSamples, learned: &profile.maximumWidth
                )
            }
            if observation.observed.height < observation.requested.height {
                updateMaximum(
                    observation.observed.height, pending: &profile.pendingMaximumHeight,
                    samples: &profile.pendingMaximumHeightSamples, learned: &profile.maximumHeight
                )
            }
        }
        if observation.outcome == .exact {
            if let minimum = profile.minimumWidth, observation.observed.width < minimum {
                profile.minimumWidth = observation.observed.width
                profile.pendingMinimumWidth = nil
                profile.pendingMinimumWidthSamples = 0
            }
            if let minimum = profile.minimumHeight, observation.observed.height < minimum {
                profile.minimumHeight = observation.observed.height
                profile.pendingMinimumHeight = nil
                profile.pendingMinimumHeightSamples = 0
            }
            if let maximum = profile.maximumWidth, observation.observed.width > maximum {
                profile.maximumWidth = observation.observed.width
                profile.pendingMaximumWidth = nil
                profile.pendingMaximumWidthSamples = 0
            }
            if let maximum = profile.maximumHeight, observation.observed.height > maximum {
                profile.maximumHeight = observation.observed.height
                profile.pendingMaximumHeight = nil
                profile.pendingMaximumHeightSamples = 0
            }
        }
        if let index { catalog.profiles[index] = profile } else { catalog.profiles.append(profile) }
        try persistence?.save(catalog)
    }

    public func snapshot() -> WindowGeometryProfileCatalog { catalog }

    public func recordCapabilities(
        _ capabilities: GeometryCapabilities, for window: NormalizedWindow,
        context: WindowGeometryProfileContext = .init(), observedAt: Date = Date()
    ) throws {
        guard let identity = WindowGeometryProfileIdentity(window: window) else { return }
        let index = catalog.profiles.firstIndex { $0.identity == identity && $0.context == context }
        var profile = index.map { catalog.profiles[$0] } ?? WindowGeometryProfile(
            identity: identity, context: context, correctiveAttemptCount: 1, sampleCount: 0,
            successfulSampleCount: 0, lastObservedAt: observedAt)
        profile.geometryCapabilities = WindowCapabilityPolicy.merging(
            capabilities, into: profile.geometryCapabilities)
        profile.lastObservedAt = observedAt
        if let index { catalog.profiles[index] = profile } else { catalog.profiles.append(profile) }
        try persistence?.save(catalog)
    }

    public func mergingCapabilities(
        into inventory: InventorySnapshot,
        context: WindowGeometryProfileContext = .init()
    ) -> InventorySnapshot {
        var inventory = inventory
        inventory.windows = inventory.windows.map { window in
            guard let profile = profile(for: window, context: context) else { return window }
            var window = window
            window.geometryCapabilities = WindowCapabilityPolicy.merging(
                profile.geometryCapabilities, into: window.geometryCapabilities)
            return window
        }
        return inventory
    }

    public func profile(
        for window: NormalizedWindow, context: WindowGeometryProfileContext = .init()
    ) -> WindowGeometryProfile? {
        guard let identity = WindowGeometryProfileIdentity(window: window) else { return nil }
        return catalog.profiles.first { $0.identity == identity && $0.context == context }
    }

    private func updateMinimum(
        _ value: Double, pending: inout Double?, samples: inout Int, learned: inout Double?
    ) {
        if let pending, abs(pending - value) <= 1 {
            samples += 1
        } else {
            pending = value
            samples = 1
        }
        if samples >= 3 { learned = max(learned ?? 0, value) }
    }

    private func updateMaximum(
        _ value: Double, pending: inout Double?, samples: inout Int, learned: inout Double?
    ) {
        if let pending, abs(pending - value) <= 1 { samples += 1 } else { pending = value; samples = 1 }
        if samples >= 3 { learned = min(learned ?? value, value) }
    }
}
