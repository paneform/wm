import Foundation

public struct InventoryScanConfiguration: Sendable {
    public var perApplicationTimeout: Duration

    public init(perApplicationTimeout: Duration = .seconds(2)) {
        self.perApplicationTimeout = perApplicationTimeout
    }
}

public actor InventoryScanner {
    private let sources: InventorySources
    private let configuration: InventoryScanConfiguration

    public init(sources: InventorySources, configuration: InventoryScanConfiguration = .init()) {
        self.sources = sources
        self.configuration = configuration
    }

    @MainActor
    public init(configuration: InventoryScanConfiguration = .init()) {
        self.init(sources: .system(), configuration: configuration)
    }

    public func scan() async -> InventorySnapshot {
        let clock = ContinuousClock()
        let started = clock.now
        async let displayResult = sources.displays.displays()
        async let cgResult = sources.coreGraphics.windows()
        let applicationResult = await sources.accessibility.applications()
        let (axWindows, appScans) = await scanApplications(applicationResult.value, clock: clock)
        let displays = await displayResult
        let cgWindows = await cgResult
        let joined = WindowNormalizer.normalize(ax: axWindows, cg: cgWindows.value, displays: displays.value)
        var health = [displays.health, applicationResult.health, cgWindows.health]
        if appScans.contains(where: { $0.status != .succeeded }) {
            let failures = appScans.filter { $0.status != .succeeded }
            let issues = failures.prefix(5).map {
                "AX scan for \($0.application.name) (pid \($0.application.pid)) \($0.status.rawValue)"
            }
            health[1].status = health[1].status == .unhealthy ? .unhealthy : .degraded
            health[1].issues.append(contentsOf: issues + (failures.count > 5 ? ["\(failures.count - 5) additional AX application scans failed"] : []))
        }

        return InventorySnapshot(
            timestamp: Date(),
            durationMilliseconds: milliseconds(started.duration(to: clock.now)),
            displays: displays.value,
            rawAXWindows: axWindows,
            rawCGWindows: cgWindows.value,
            windows: joined.windows,
            rejectedAXWindows: joined.rejected,
            joinDecisions: joined.decisions,
            sourceHealth: health,
            appScans: appScans
        )
    }

    private func scanApplications(
        _ applications: [ApplicationObservation],
        clock: ContinuousClock
    ) async -> ([RawAXWindow], [AppScanResult]) {
        await withTaskGroup(of: AppScanOutput.self) { group in
            for application in applications {
                let source = sources.accessibility
                let timeout = configuration.perApplicationTimeout
                group.addTask {
                    let started = clock.now
                    do {
                        let windows = try await withThrowingTaskGroup(of: [RawAXWindow].self) { race in
                            race.addTask { try await source.windows(for: application) }
                            race.addTask {
                                try await Task.sleep(for: timeout)
                                throw ScanError.timedOut
                            }
                            let result = try await race.next() ?? []
                            race.cancelAll()
                            return result
                        }
                        return AppScanOutput(
                            windows: windows,
                            result: AppScanResult(
                                application: application,
                                status: .succeeded,
                                durationMilliseconds: milliseconds(started.duration(to: clock.now)),
                                windowCount: windows.count,
                                issues: []
                            )
                        )
                    } catch {
                        let timedOut = error is ScanError
                        return AppScanOutput(
                            windows: [],
                            result: AppScanResult(
                                application: application,
                                status: timedOut ? .timedOut : .failed,
                                durationMilliseconds: milliseconds(started.duration(to: clock.now)),
                                windowCount: 0,
                                issues: [timedOut ? "per-app AX scan exceeded its deadline" : String(describing: error)]
                            )
                        )
                    }
                }
            }

            var windows: [RawAXWindow] = []
            var scans: [AppScanResult] = []
            for await output in group {
                windows.append(contentsOf: output.windows)
                scans.append(output.result)
            }
            windows.sort { ($0.pid, $0.title ?? "") < ($1.pid, $1.title ?? "") }
            scans.sort { $0.application.pid < $1.application.pid }
            return (windows, scans)
        }
    }
}

private struct AppScanOutput: Sendable {
    var windows: [RawAXWindow]
    var result: AppScanResult
}

private enum ScanError: Error {
    case timedOut
}

private func milliseconds(_ duration: Duration) -> Int {
    let components = duration.components
    return Int(components.seconds * 1_000 + components.attoseconds / 1_000_000_000_000_000)
}
