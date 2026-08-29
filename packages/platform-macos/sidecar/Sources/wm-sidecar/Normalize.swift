import Foundation

/// Ports the ground-truth `WindowNormalizer` behavior:
/// - stable ids (`window:cg:<n>` / `window:ax:<pid>:…:<fnv1a64>:<occurrence>`)
/// - evidence-scored AX↔CG join (cg id +100, frame +20, title +5, pid
///   prerequisite; exact frames may join alone, equal-evidence ties refuse it)
/// - structural filtering of system surfaces and transient/uncertain windows,
///   which never cross the boundary (the engine only sees actionable windows).
enum Normalizer {
    struct Joined {
        var value: WindowValue
        var raw: RawAXWindow
        var cgWindowID: UInt32?
    }

    static func normalize(
        ax: [RawAXWindow],
        cg: [RawCGWindow],
        hiddenPids: Set<Int32>
    ) -> [Joined] {
        var availableCG = Set(cg.indices)
        var occurrences: [String: Int] = [:]
        var joined: [Joined] = []

        for observation in ax {
            let match = bestMatch(for: observation, in: cg, available: availableCG)
            if let cgIndex = match.cgIndex { availableCG.remove(cgIndex) }
            guard isReportable(observation) else { continue }

            let index = occurrenceIndex(for: observation, occurrences: &occurrences)
            let cgObservation = match.cgIndex.map { cg[$0] }
            let id = stableID(index: index, ax: observation, cg: cgObservation)

            // CG is the existence oracle: a normal AX window with no matching
            // surface is uncertain unless minimized, so it is not reported.
            if cgObservation == nil && observation.minimized != true { continue }

            joined.append(Joined(
                value: makeValue(
                    id: id,
                    ax: observation,
                    cgTitle: cgObservation?.title,
                    hidden: hiddenPids.contains(observation.pid)),
                raw: observation,
                cgWindowID: cgObservation?.cgWindowID ?? observation.cgWindowID))
        }
        return joined
    }

    // MARK: Join

    private struct Match {
        var cgIndex: Int?
        var signals: [String]
    }

    private static func bestMatch(for ax: RawAXWindow, in cg: [RawCGWindow], available: Set<Int>) -> Match {
        struct Candidate {
            var score: Int
            var index: Int
            var signals: [String]
        }
        let candidates = available.compactMap { index -> Candidate? in
            let candidate = cg[index]
            guard candidate.pid == ax.pid else { return nil } // pid prerequisite
            var signals = ["pid"]
            var score = 10
            let exactFrame = ax.frame != nil && ax.frame == candidate.frame
            let validAXID = ax.cgWindowID.flatMap { $0 == 0 ? nil : $0 }
            let validCGID = candidate.cgWindowID.flatMap { $0 == 0 ? nil : $0 }
            if let validAXID, validAXID == validCGID {
                signals.append("cg_window_id")
                score += 100
            }
            if let axFrame = ax.frame, let cgFrame = candidate.frame, axFrame.approximatelyEquals(cgFrame) {
                signals.append("frame")
                score += 20
            }
            if let axTitle = normalized(ax.title), let cgTitle = normalized(candidate.title), axTitle == cgTitle {
                signals.append("title")
                score += 5
            }
            // Exact id/frame join or a frame+title strong pair. Approximate
            // frame evidence alone is insufficient.
            guard signals.contains("cg_window_id")
                || exactFrame
                || (signals.contains("frame") && signals.contains("title")) else { return nil }
            return Candidate(score: score, index: index, signals: signals)
        }
        let sortedCandidates = candidates.sorted { lhs, rhs in
            lhs.score == rhs.score ? lhs.index < rhs.index : lhs.score > rhs.score
        }
        guard let first = sortedCandidates.first else {
            return Match(cgIndex: nil, signals: ["pid"])
        }
        // Two candidates with equal evidence: refuse the join entirely.
        if sortedCandidates.dropFirst().first?.score == first.score {
            return Match(cgIndex: nil, signals: first.signals)
        }
        return Match(cgIndex: first.index, signals: first.signals)
    }

    // MARK: Structural filtering

    private static let structurallyIgnoredBundles: Set<String> = ["com.apple.autofillpanelservice"]
    private static let structurallyIgnoredAppNames: Set<String> = ["autofillpanelservice"]
    private static let systemUIBundles: Set<String> = [
        "com.apple.controlcenter",
        "com.apple.dock",
        "com.apple.notificationcenterui",
        "com.apple.systemuiserver",
    ]
    private static let transientSubroles: Set<String> = [
        "AXDialog", "AXSheet", "AXSystemDialog", "AXFloatingWindow",
    ]

    /// True when the window is a reportable, actionable AX window. Anything
    /// the ground truth classified systemUI/transient/uncertain is filtered.
    private static func isReportable(_ window: RawAXWindow) -> Bool {
        if let bundleID = window.bundleID {
            let lowered = bundleID.lowercased()
            if structurallyIgnoredBundles.contains(lowered) || systemUIBundles.contains(lowered) {
                return false
            }
        } else if structurallyIgnoredAppNames.contains(window.appName.lowercased()) {
            // Without a bundle id the app name is the identity fallback.
            return false
        }
        guard window.role == "AXWindow" else { return false }
        if let subrole = window.subrole, transientSubroles.contains(subrole) { return false }
        if window.modal == true { return false }
        if window.hasParent { return false }
        guard let frame = window.frame, frame.isUsable else { return false }
        if !window.readErrors.isEmpty { return false }
        return true
    }

    // MARK: Identity

    private static func occurrenceIndex(for window: RawAXWindow, occurrences: inout [String: Int]) -> Int {
        let key = "\(window.pid):\(window.role ?? ""):\(window.subrole ?? ""):\(window.title ?? "")"
        let occurrence = occurrences[key, default: 0]
        occurrences[key] = occurrence + 1
        return occurrence
    }

    private static func stableID(index: Int, ax: RawAXWindow, cg: RawCGWindow?) -> String {
        if let cgWindowID = cg?.cgWindowID ?? ax.cgWindowID, cgWindowID != 0 {
            return "window:cg:\(cgWindowID)"
        }
        let hash = fnv1a64((ax.title ?? ""))
        return "window:ax:\(ax.pid):\(ax.role ?? ""):\(ax.subrole ?? ""):\(String(hash, radix: 16)):\(index)"
    }

    /// FNV-1a 64 over Unicode scalars, identical to the ground-truth minting.
    static func fnv1a64(_ string: String) -> UInt64 {
        string.unicodeScalars.reduce(UInt64(14_695_981_039_346_656_037)) {
            ($0 ^ UInt64($1.value)) &* 1_099_511_628_211
        }
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return trimmed.isEmpty ? nil : trimmed
    }

    // MARK: Observation building

    private static func makeValue(id: String, ax: RawAXWindow, cgTitle: String?, hidden: Bool) -> WindowValue {
        WindowValue(
            id: id,
            pid: Int(ax.pid),
            bundleId: ax.bundleID,
            executablePath: ax.executablePath,
            title: ax.title ?? cgTitle,
            role: ax.role ?? "",
            subrole: ax.subrole,
            frame: (ax.frame ?? Rect(x: 0, y: 0, width: 0, height: 0)).frameValue,
            minimized: ax.minimized ?? false,
            hidden: hidden,
            fullscreen: ax.fullscreen ?? false,
            focused: ax.focused ?? false,
            capabilities: capabilityValue(movable: ax.movable, resizable: ax.resizable))
    }

    /// AXMovable/AXResizable are platform-reported capability evidence.
    private static func capabilityValue(movable: Bool?, resizable: Bool?) -> CapabilitiesValue {
        func state(_ reported: Bool?) -> String {
            switch reported {
            case .some(true): "supported"
            case .some(false): "fixed"
            case .none: "unknown"
            }
        }
        return CapabilitiesValue(
            movable: state(movable),
            resizable: state(resizable),
            movableEvidence: "platform_report",
            resizableEvidence: "platform_report")
    }
}
