import ApplicationServices
import Testing
@testable import wm_sidecar

@Test func nativeWriteErrorsAreClassified() {
    #expect(AdapterError.writeFailure(.success) == nil)
    #expect(AdapterError.writeFailure(.invalidUIElement)?.wireCode == "stale")
    #expect(AdapterError.writeFailure(.cannotComplete)?.wireCode == "not_controllable")
    #expect(AdapterError.writeFailure(.illegalArgument)?.wireCode == "rejected")
}
