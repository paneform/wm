import ApplicationServices
import Foundation
import Testing

@testable import wm_sidecar

@Suite struct WindowInspectionTests {
    @Test func failedWindowEnumerationDoesNotPublishReturnedElementsAsSuccess() throws {
        let element = AXUIElementCreateApplication(42)
        let raw = [element] as CFArray
        let failed = AXDiagnosticReader.windowList(error: .cannotComplete, raw: raw)
        #expect(failed.elements.isEmpty)
        let output = try json(failed.query)
        #expect(output["errorCode"] as? Int == -25204)
        #expect(output["value"] is NSNull)
        let successful = AXDiagnosticReader.windowList(error: .success, raw: raw)
        #expect(successful.elements.count == 1)
        #expect(try json(successful.query)["value"] as? Int == 1)
        let empty = AXDiagnosticReader.windowList(error: .success, raw: [] as CFArray)
        #expect(try json(empty.query)["value"] as? Int == 0)
        let malformed = AXDiagnosticReader.windowList(error: .success, raw: "not an array" as CFString)
        #expect(try json(malformed.query)["valueType"] as? String == "unsupported")
    }

    @Test func rawMinimizedWindowsRetainSettableEvidenceAndFailedGeometry() throws {
        let window = WindowDiagnosticsValue.RawWindow(
            index: 0, identity: .init(pid: nil, pidErrorCode: -25202, matchesTarget: false),
            queries: [
                AXDiagnosticReader.result(scope: "window", attribute: "AXMinimized", error: .success, value: .boolean(true)),
                AXDiagnosticReader.result(scope: "window", attribute: "AXMinimized.settable", error: .success, value: .boolean(true)),
                AXDiagnosticReader.result(scope: "window", attribute: "AXPosition", error: .noValue, value: .point(0, 0)),
            ])
        let output = try json(window)
        let identity = try #require(output["identity"] as? [String: Any])
        #expect(identity["pid"] is NSNull)
        let queries = try #require(output["queries"] as? [[String: Any]])
        #expect(queries[1]["value"] as? Bool == true)
        #expect(queries[2]["value"] is NSNull)
        #expect(queries[2]["errorCode"] as? Int == Int(AXError.noValue.rawValue))
    }

    private func json<T: Encodable>(_ value: T) throws -> [String: Any] {
        try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
    }

    @Test func failedQueriesRetainRawErrorsAndNeverPublishAnUnverifiedValue() throws {
        let result = AXDiagnosticReader.result(
            scope: "system", attribute: "AXFocusedApplication",
            error: .cannotComplete, value: .boolean(true))
        let output = try json(result)
        #expect(output["errorCode"] as? Int == -25204)
        #expect(output["errorName"] as? String == "cannot_complete")
        #expect(output["valueType"] as? String == "none")
        #expect(output["value"] is NSNull)
    }

    @Test func missingWindowAndRegistrationFactsEncodeExplicitNulls() throws {
        let diagnostics = WindowDiagnosticsValue(
            capturedAt: "2026-10-08T00:00:00Z",
            observer: .init(pid: 99, bundleId: nil, accessibility: false, screenRecording: false),
            target: .init(windowId: "missing", pid: nil, registered: false, activationPolicy: nil, active: nil, hidden: nil),
            nsFrontmostPidBefore: nil, nsFrontmostPidAfter: nil, resolutionError: "not_found", queries: [])
        let output = try json(WindowInspectionValue(window: nil, diagnostics: diagnostics))
        #expect(output["window"] is NSNull)
        let data = try #require(output["diagnostics"] as? [String: Any])
        let target = try #require(data["target"] as? [String: Any])
        #expect(target["registered"] as? Bool == false)
        #expect(target["pid"] is NSNull)
        #expect(target["activationPolicy"] is NSNull)
        #expect(data["nsFrontmostPidBefore"] is NSNull)
        #expect(data["resolutionError"] as? String == "not_found")
    }
}
