import ApplicationServices
import Darwin
import Foundation

/// Retained identity, not retained geometry. Only current normalized windows
/// are actionable; unreadable instances remain available for later matching.
struct WindowLifecycle {
    enum ProcessState: Equatable {
        case running(String)
        case exited
        case unavailable
    }

    private struct Instance {
        var pid: Int32
        var process: ProcessState
        var element: AXUIElement?
        var cgWindowID: UInt32?
        var token: String
    }

    private var instances: [String: Instance] = [:]
    private let session = UUID().uuidString
    private var generation = 0

    mutating func reconcile(
        joined: [Normalizer.Joined], stalled: Set<Int32>, cgWindows: [RawCGWindow] = [],
        processState: (Int32) -> ProcessState = Self.processState,
        elementInvalid: (AXUIElement) -> Bool = Self.elementInvalid
    ) -> (windows: [Normalizer.Joined], unavailable: [String], closed: [String]) {
        let states = Dictionary(
            uniqueKeysWithValues:
                Set(instances.values.map(\.pid) + joined.map { $0.raw.pid }).map { ($0, processState($0)) })
        let windows = joined.filter { states[$0.raw.pid] != .exited }
            .map { attachIdentity($0, process: states[$0.raw.pid] ?? .unavailable) }
        let missing = retireMissing(
            observed: Set(windows.map { $0.value.id }), states: states,
            stalled: stalled, cgWindows: cgWindows, elementInvalid: elementInvalid)
        return (windows, missing.unavailable, missing.closed)
    }

    private mutating func retireMissing(
        observed: Set<String>, states: [Int32: ProcessState], stalled: Set<Int32>, cgWindows: [RawCGWindow],
        elementInvalid: (AXUIElement) -> Bool
    ) -> (unavailable: [String], closed: [String]) {
        let missing = instances.filter { !observed.contains($0.key) }
        let closed = missing.compactMap { id, instance in
            isClosed(
                instance, process: states[instance.pid] ?? .unavailable,
                stalled: stalled, cgWindows: cgWindows, elementInvalid: elementInvalid) ? id : nil
        }
        for id in closed { instances.removeValue(forKey: id) }
        let retired = Set(closed)
        return (missing.keys.filter { !retired.contains($0) }.sorted(), closed.sorted())
    }

    private mutating func attachIdentity(_ joined: Normalizer.Joined, process: ProcessState) -> Normalizer.Joined {
        var joined = joined
        let id = matchingID(joined, process: process) ?? joined.value.id
        joined.value.id = id
        if let previous = instances[id], matches(previous, window: joined, process: process) {
            joined.value.instanceId = previous.token
            refreshInstance(id, window: joined, process: process)
        } else {
            joined.value.instanceId = createInstance(id, window: joined, process: process)
        }
        return joined
    }

    private mutating func refreshInstance(_ id: String, window: Normalizer.Joined, process: ProcessState) {
        instances[id]?.element = window.raw.reference?.element
        if let cgID = window.cgWindowID { instances[id]?.cgWindowID = cgID }
        // Preserve a successfully sampled process start time through read failures.
        guard process != .unavailable else { return }
        instances[id]?.process = process
    }

    private mutating func createInstance(_ id: String, window: Normalizer.Joined, process: ProcessState) -> String {
        generation += 1
        let token = "\(session):\(generation)"
        instances[id] = Instance(
            pid: window.raw.pid, process: process, element: window.raw.reference?.element,
            cgWindowID: window.cgWindowID, token: token)
        return token
    }

    private func matchingID(_ joined: Normalizer.Joined, process: ProcessState) -> String? {
        if let previous = instances[joined.value.id], matches(previous, window: joined, process: process) {
            return joined.value.id
        }
        return instances.first { matches($0.value, window: joined, process: process) }?.key
    }

    private func matches(_ previous: Instance, window: Normalizer.Joined, process: ProcessState) -> Bool {
        guard previous.pid == window.raw.pid, process != .exited else { return false }
        if case .running(let old) = previous.process, case .running(let new) = process, old != new { return false }
        // AX handles can be rebuilt after wake. The same CG handle and verified
        // process instance still identify the existing window.
        if case .running(let old) = previous.process, case .running(let new) = process, old == new,
            let cgID = previous.cgWindowID, cgID == window.cgWindowID
        {
            return true
        }
        guard let old = previous.element, let element = window.raw.reference?.element else { return false }
        return CFEqual(old, element)
    }

    private func isClosed(
        _ instance: Instance, process: ProcessState, stalled: Set<Int32>, cgWindows: [RawCGWindow],
        elementInvalid: (AXUIElement) -> Bool
    ) -> Bool {
        if process == .exited { return true }
        if case .running(let old) = instance.process, case .running(let new) = process, old != new { return true }
        if let cgID = instance.cgWindowID,
            cgWindows.contains(where: { $0.cgWindowID == cgID && $0.pid == instance.pid })
        {
            return false
        }
        guard !stalled.contains(instance.pid), let element = instance.element else { return false }
        return elementInvalid(element)
    }

    static func processState(_ pid: Int32) -> ProcessState {
        var info = proc_bsdinfo()
        let size = MemoryLayout<proc_bsdinfo>.size
        let read = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(size))
        if read == size { return .running("\(info.pbi_start_tvsec):\(info.pbi_start_tvusec)") }
        // Failure to read process metadata is not evidence of process exit.
        return kill(pid, 0) == -1 && errno == ESRCH ? .exited : .unavailable
    }

    static func elementInvalid(_ element: AXUIElement) -> Bool {
        setMessagingTimeout(element, 0.05)
        defer { setMessagingTimeout(element, 1.5) }
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &value) == .invalidUIElement
    }
}
