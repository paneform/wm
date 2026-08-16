import Foundation

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
    public var correctiveAttemptCount: Int
    public var sampleCount: Int
    public var successfulSampleCount: Int
    public var lastObservedAt: Date
    public var pendingMinimumWidth: Double?
    public var pendingMinimumWidthSamples: Int
    public var pendingMinimumHeight: Double?
    public var pendingMinimumHeightSamples: Int

    public init(
        identity: WindowGeometryProfileIdentity, context: WindowGeometryProfileContext,
        minimumWidth: Double? = nil, minimumHeight: Double? = nil,
        correctiveAttemptCount: Int, sampleCount: Int, successfulSampleCount: Int,
        lastObservedAt: Date, pendingMinimumWidth: Double? = nil, pendingMinimumWidthSamples: Int = 0,
        pendingMinimumHeight: Double? = nil, pendingMinimumHeightSamples: Int = 0
    ) {
        self.identity = identity
        self.context = context
        self.minimumWidth = minimumWidth
        self.minimumHeight = minimumHeight
        self.correctiveAttemptCount = correctiveAttemptCount
        self.sampleCount = sampleCount
        self.successfulSampleCount = successfulSampleCount
        self.lastObservedAt = lastObservedAt
        self.pendingMinimumWidth = pendingMinimumWidth
        self.pendingMinimumWidthSamples = pendingMinimumWidthSamples
        self.pendingMinimumHeight = pendingMinimumHeight
        self.pendingMinimumHeightSamples = pendingMinimumHeightSamples
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
        }
        if let index { catalog.profiles[index] = profile } else { catalog.profiles.append(profile) }
        try persistence?.save(catalog)
    }

    public func snapshot() -> WindowGeometryProfileCatalog { catalog }

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
}
