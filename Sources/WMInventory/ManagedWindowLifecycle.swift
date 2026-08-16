import Foundation

public enum WindowManagementOverride: Sendable {
    case managed, unmanaged
}

public struct WindowLifetime: Hashable, Sendable {
    public var windowID: String
    public var pid: Int32

    public init(windowID: String, pid: Int32) {
        self.windowID = windowID
        self.pid = pid
    }
}

public struct WindowLifecycleUpdate: Sendable {
    public var windows: [NormalizedWindow]
    public var verifiedClosedLifetimes: Set<WindowLifetime>
    public var newlyUnmanagedWindowIDs: Set<String>
    public var replacements: [String: String]

    public init(
        windows: [NormalizedWindow],
        verifiedClosedLifetimes: Set<WindowLifetime>,
        newlyUnmanagedWindowIDs: Set<String> = [], replacements: [String: String] = [:]
    ) {
        self.windows = windows
        self.verifiedClosedLifetimes = verifiedClosedLifetimes
        self.newlyUnmanagedWindowIDs = newlyUnmanagedWindowIDs
        self.replacements = replacements
    }
}

public struct ManagedWindowLifecycle: Sendable {
    private struct RetainedWindow: Sendable {
        var window: NormalizedWindow
        var override: WindowManagementOverride?
    }

    private var retained: [String: RetainedWindow] = [:]

    public init() {}

    public mutating func setOverride(_ override: WindowManagementOverride, for windowID: String) -> WindowLifecycleUpdate? {
        guard var record = retained[windowID] else { return nil }
        let wasManaged = record.window.management == .managed
        record.override = override
        record.window = applying(override, to: record.window)
        retained[windowID] = record
        return update(newlyUnmanaged: wasManaged && override == .unmanaged ? [windowID] : [])
    }

    public mutating func reconcile(_ inventory: InventorySnapshot) -> WindowLifecycleUpdate {
        let livePIDs = Set(inventory.appScans.map(\.application.pid))
        let successfulPIDs = Set(inventory.appScans.filter { $0.status == .succeeded }.map(\.application.pid))
        let observedByID = Dictionary(uniqueKeysWithValues: inventory.windows.map { ($0.id, $0) })
        var verifiedClosed: Set<WindowLifetime> = []
        var replacements: [String: String] = [:]
        var closedWindows: [NormalizedWindow] = []

        for (id, previous) in retained where observedByID[id] == nil {
            if (inventory.applicationEnumerationSucceeded && !livePIDs.contains(previous.window.pid))
                || successfulPIDs.contains(previous.window.pid) {
                retained.removeValue(forKey: id)
                verifiedClosed.insert(.init(windowID: id, pid: previous.window.pid))
                closedWindows.append(previous.window)
            }
        }

        for window in inventory.windows {
            let previous = retained[window.id]
            if let previous, previous.window.pid != window.pid {
                retained.removeValue(forKey: window.id)
                verifiedClosed.insert(.init(windowID: window.id, pid: previous.window.pid))
                closedWindows.append(previous.window)
            }
            retained[window.id] = RetainedWindow(
                window: applying(previous?.window.pid == window.pid ? previous?.override : nil, to: window),
                override: previous?.window.pid == window.pid ? previous?.override : nil
            )
        }

        for previous in closedWindows {
            let candidates = inventory.windows.filter {
                $0.id != previous.id && $0.pid == previous.pid
                    && $0.bundleID == previous.bundleID && $0.role == previous.role && $0.subrole == previous.subrole
            }
            if candidates.count == 1 { replacements[previous.id] = candidates[0].id }
        }

        return update(verifiedClosed: verifiedClosed, replacements: replacements)
    }

    private func update(
        verifiedClosed: Set<WindowLifetime> = [],
        newlyUnmanaged: Set<String> = []
        , replacements: [String: String] = [:]
    ) -> WindowLifecycleUpdate {
        WindowLifecycleUpdate(
            windows: retained.values.map(\.window).filter { $0.management == .managed }.sorted { $0.id < $1.id },
            verifiedClosedLifetimes: verifiedClosed,
            newlyUnmanagedWindowIDs: newlyUnmanaged
            , replacements: replacements
        )
    }

    private func applying(_ override: WindowManagementOverride?, to window: NormalizedWindow) -> NormalizedWindow {
        var window = window
        switch override {
        case .managed: window.management = .managed
        case .unmanaged: window.management = .unmanaged
        case nil: window.management = window.classification == .normal ? .managed : window.management
        }
        return window
    }
}
