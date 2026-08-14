import Foundation

public struct SourceResult<Value: Sendable>: Sendable {
    public var value: Value
    public var health: SourceHealth

    public init(value: Value, health: SourceHealth) {
        self.value = value
        self.health = health
    }
}

public protocol DisplayInventorySource: Sendable {
    func displays() async -> SourceResult<[DisplayObservation]>
}

public protocol AccessibilityInventorySource: Sendable {
    func applications() async -> SourceResult<[ApplicationObservation]>
    func windows(for application: ApplicationObservation) async throws -> [RawAXWindow]
}

public protocol CoreGraphicsInventorySource: Sendable {
    func windows() async -> SourceResult<[RawCGWindow]>
}

public struct InventorySources: Sendable {
    public var displays: any DisplayInventorySource
    public var accessibility: any AccessibilityInventorySource
    public var coreGraphics: any CoreGraphicsInventorySource

    public init(
        displays: any DisplayInventorySource,
        accessibility: any AccessibilityInventorySource,
        coreGraphics: any CoreGraphicsInventorySource
    ) {
        self.displays = displays
        self.accessibility = accessibility
        self.coreGraphics = coreGraphics
    }

    @MainActor
    public static func system() -> Self {
        Self(
            displays: AppKitDisplayInventorySource(),
            accessibility: SystemAccessibilityInventorySource(),
            coreGraphics: SystemCoreGraphicsInventorySource()
        )
    }
}
