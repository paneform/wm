import Foundation

public struct NormalizationResult: Sendable {
    public var windows: [NormalizedWindow]
    public var rejected: [RejectedAXWindow]
    public var decisions: [JoinDecision]

    public init(windows: [NormalizedWindow], rejected: [RejectedAXWindow], decisions: [JoinDecision]) {
        self.windows = windows
        self.rejected = rejected
        self.decisions = decisions
    }
}

public enum WindowNormalizer {
    public static func normalize(
        ax: [RawAXWindow],
        cg: [RawCGWindow],
        displays: [DisplayObservation] = []
    ) -> NormalizationResult {
        var availableCG = Set(cg.indices)
        var decisions: [JoinDecision] = []
        var windows: [NormalizedWindow] = []
        var rejected: [RejectedAXWindow] = []

        for (axIndex, observation) in ax.enumerated() {
            let match = bestMatch(for: observation, in: cg, available: availableCG)
            if let cgIndex = match.cgIndex { availableCG.remove(cgIndex) }
            decisions.append(JoinDecision(
                axIndex: axIndex,
                cgIndex: match.cgIndex,
                confidence: match.confidence,
                signals: match.signals,
                reasons: match.reasons
            ))

            let classification = classify(observation)
            if classification.classification == .uncertain || classification.classification == .systemUI {
                rejected.append(RejectedAXWindow(axIndex: axIndex, window: observation, reasons: classification.reasons))
            }
            let cgObservation = match.cgIndex.map { cg[$0] }
            let effectiveClassification: Classification
            if classification.classification == .normal,
               cgObservation == nil,
               observation.minimized != true {
                effectiveClassification = Classification(
                    classification: .uncertain,
                    management: .pending,
                    reasons: classification.reasons + ["normal AX window has no matching Core Graphics surface"]
                )
            } else {
                effectiveClassification = classification
            }
            windows.append(makeWindow(
                index: axIndex,
                ax: observation,
                cg: cgObservation,
                match: match,
                classification: effectiveClassification,
                displayID: displayID(for: observation.frame ?? cgObservation?.frame, displays: displays)
            ))
        }

        for cgIndex in availableCG.sorted() {
            decisions.append(JoinDecision(
                axIndex: nil,
                cgIndex: cgIndex,
                confidence: .cgOnly,
                signals: cg[cgIndex].pid == nil ? [] : ["pid"],
                reasons: ["no AX-controllable observation matched this CG surface"]
            ))
        }
        return NormalizationResult(windows: windows, rejected: rejected, decisions: decisions)
    }

    private static func bestMatch(for ax: RawAXWindow, in cg: [RawCGWindow], available: Set<Int>) -> Match {
        let candidates = available.compactMap { index -> (Int, Match)? in
            let candidate = cg[index]
            guard candidate.pid == ax.pid else { return nil }
            var signals = ["pid"]
            var score = 10
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
            let confidence: JoinConfidence
            if signals.contains("cg_window_id") { confidence = .exact }
            else if signals.contains("frame") && signals.contains("title") { confidence = .strong }
            else if signals.count > 1 { confidence = .weak }
            else { return nil }
            return (score, Match(cgIndex: index, confidence: confidence, signals: signals, reasons: []))
        }
        let sorted = candidates.sorted { lhs, rhs in
            lhs.0 == rhs.0 ? (lhs.1.cgIndex ?? .max) < (rhs.1.cgIndex ?? .max) : lhs.0 > rhs.0
        }
        guard let first = sorted.first else {
            return Match(cgIndex: nil, confidence: .axOnly, signals: ["pid"], reasons: ["no sufficiently similar CG observation"])
        }
        if sorted.dropFirst().first?.0 == first.0 {
            return Match(cgIndex: nil, confidence: .axOnly, signals: first.1.signals, reasons: ["multiple CG observations had equal join evidence"])
        }
        return first.1
    }

    private static func classify(_ window: RawAXWindow) -> Classification {
        var reasons = window.readErrors
        guard window.role == "AXWindow" else {
            reasons.append(window.role == nil ? "AX role is unavailable" : "AX role is not AXWindow")
            return Classification(classification: .uncertain, management: .ineligible, reasons: reasons)
        }
        let transient = ["AXDialog", "AXSheet", "AXSystemDialog", "AXFloatingWindow"]
        if let subrole = window.subrole, transient.contains(subrole) {
            reasons.append("transient AX subrole: \(subrole)")
            return Classification(classification: .transient, management: .unmanaged, reasons: reasons)
        }
        let systemUIBundles = [
            "com.apple.controlcenter",
            "com.apple.dock",
            "com.apple.notificationcenterui",
            "com.apple.systemuiserver",
        ]
        if let bundleID = window.bundleID, systemUIBundles.contains(bundleID) {
            reasons.append("system UI bundle")
            return Classification(classification: .systemUI, management: .ineligible, reasons: reasons)
        }
        guard let frame = window.frame, frame.isUsable else {
            reasons.append("window has no usable frame")
            return Classification(classification: .uncertain, management: .ineligible, reasons: reasons)
        }
        if window.readErrors.isEmpty {
            return Classification(classification: .normal, management: .unmanaged, reasons: [])
        }
        reasons.append("one or more AX attributes could not be read")
        return Classification(classification: .uncertain, management: .ineligible, reasons: reasons)
    }

    private static func makeWindow(
        index: Int,
        ax: RawAXWindow,
        cg: RawCGWindow?,
        match: Match,
        classification: Classification,
        displayID: String?
    ) -> NormalizedWindow {
        let issues = ax.readErrors + match.reasons
        return NormalizedWindow(
            id: "window:ax:\(ax.pid):\(index)",
            pid: ax.pid,
            appName: ax.appName,
            bundleID: ax.bundleID,
            executablePath: ax.executablePath,
            title: ax.title ?? cg?.title,
            role: ax.role,
            subrole: ax.subrole,
            frame: ax.frame ?? cg?.frame,
            displayID: displayID,
            classification: classification.classification,
            management: classification.management,
            rejectionReasons: classification.reasons,
            cgWindowID: cg?.cgWindowID ?? ax.cgWindowID,
            joinConfidence: match.confidence,
            joinSignals: match.signals,
            minimized: ax.minimized,
            fullscreen: ax.fullscreen,
            focused: ax.focused,
            main: ax.main,
            onScreen: cg?.onScreen,
            health: issues.isEmpty ? .healthy : .degraded,
            healthIssues: issues
        )
    }

    private static func displayID(for frame: InventoryRect?, displays: [DisplayObservation]) -> String? {
        guard let frame else { return nil }
        let centerX = frame.x + frame.width / 2
        let centerY = frame.y + frame.height / 2
        return displays.first {
            centerX >= $0.frame.x && centerX <= $0.frame.x + $0.frame.width
                && centerY >= $0.frame.y && centerY <= $0.frame.y + $0.frame.height
        }?.id
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized.isEmpty ? nil : normalized
    }
}

private struct Match {
    var cgIndex: Int?
    var confidence: JoinConfidence
    var signals: [String]
    var reasons: [String]
}

private struct Classification {
    var classification: WindowClassification
    var management: WindowManagement
    var reasons: [String]
}
