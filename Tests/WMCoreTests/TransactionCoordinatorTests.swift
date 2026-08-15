import Foundation
import Testing
import WMProtocol
@testable import WMCore

private actor Probe {
    var order: [String] = [], active = 0, maximum = 0, escalations = 0
    var gate: CheckedContinuation<Void, Never>?
    var observationGate: CheckedContinuation<Void, Never>?
    func run(_ value: String, gated: Bool = false) async -> TransactionOutcome<String> {
        active += 1; maximum = max(maximum, active); order.append(value)
        if gated { await withCheckedContinuation { gate = $0 } }
        active -= 1; return .init(result: value, committedStateVersion: UInt64(order.count))
    }
    func waiting() -> Bool { gate != nil }
    func release() { gate?.resume(); gate = nil }
    func escalate() { escalations += 1 }
    func observe() async { await withCheckedContinuation { observationGate = $0 } }
    func observing() -> Bool { observationGate != nil }
    func releaseObservation() { observationGate?.resume(); observationGate = nil }
}

@Test func coalescedCompletionMulticastsAndEscalates() async throws {
    let probe = Probe(), queue = TransactionCoordinator<String>(suspiciousThreshold: 3)
    let command = TransactionCommand<String>(name: "focus", idempotencyKey: "digest", observe: {
        await probe.observe()
    }, operate: { await probe.run("focus") }, escalate: { await probe.escalate() })
    let tasks = (0..<8).map { _ in Task { try await queue.submit(command) } }
    while !(await probe.observing()) { try await Task.sleep(for: .milliseconds(1)) }
    while await queue.metadata().pendingTransactions.first?.coalescedRequests != 7 {
        try await Task.sleep(for: .milliseconds(1))
    }
    await probe.releaseObservation()
    let receipts = try await tasks.asyncMap { try await $0.value }
    #expect(Set(receipts.map(\.transaction.transactionId)).count == 1)
    #expect(receipts.allSatisfy { $0.result == "focus" && $0.transaction.committedStateVersion == 1 })
    #expect(receipts.allSatisfy { $0.transaction.reconciliationEscalated })
    #expect(await probe.escalations == 1)
}

@Test func recoveryQueuesAndReleasesFIFO() async throws {
    let probe = Probe(), queue = TransactionCoordinator<String>()
    await queue.beginRecovery(reason: "topology")
    let receipts = try await Array(0..<100).asyncMap { index in
        try await queue.submit(.init(name: "item", operate: { await probe.run("\(index)") }), mode: .instant)
    }
    #expect(receipts.allSatisfy { $0.transaction.phase == .queued })
    await queue.endRecovery(success: true)
    while await queue.metadata().pendingTransactions.count > 0 { try await Task.sleep(for: .milliseconds(1)) }
    #expect(await probe.order == (0..<100).map(String.init))
}

@Test func escalationFailureIsStructuredAndPreventsOperation() async throws {
    let probe = Probe(), queue = TransactionCoordinator<String>(suspiciousThreshold: 2)
    await queue.beginRecovery(reason: "test")
    let command = TransactionCommand<String>(name: "focus", idempotencyKey: "digest", operate: {
        await probe.run("must-not-run")
    }, escalate: { throw TransactionFailure(code: .inventoryFailed, message: "reconciliation failed", retryable: true) })
    let first = Task { try await queue.submit(command) }
    let second = Task { try await queue.submit(command) }
    while await queue.metadata().pendingTransactions.first?.coalescedRequests != 1 {
        try await Task.sleep(for: .milliseconds(1))
    }
    await queue.endRecovery(success: true)
    let receipts = try await [first, second].asyncMap { try await $0.value }
    #expect(receipts.allSatisfy { $0.transaction.phase == .failed })
    #expect(receipts.allSatisfy { $0.transaction.reconciliationEscalated })
    #expect(receipts.allSatisfy { $0.transaction.failure?.code == .inventoryFailed })
    #expect(await probe.order.isEmpty)
}

@Test func internalActivationAndPeriodicWorkFollowDirectTransitionExactlyOnce() async throws {
    let probe = Probe(), queue = TransactionCoordinator<String>()
    let direct = try await queue.submit(.init(name: "command.batch", operate: {
        await probe.run("batch")
    }))
    let activation = try await queue.submit(.init(name: "observer.activation", operate: {
        await probe.run("activation")
    }))
    let periodic = try await queue.submit(.init(name: "observer.periodic", operate: {
        await probe.run("periodic")
    }))
    #expect([direct, activation, periodic].allSatisfy { $0.transaction.phase == .committed })
    #expect(await probe.order == ["batch", "activation", "periodic"])
    #expect(await probe.maximum == 1)
}

@Test func sanitizedFailureAlsoReportsActionableInternalError() async throws {
    actor Errors { var values: [String] = []; func append(_ value: String) { values.append(value) } }
    enum LiveFailure: Error { case staleWorkspaceAfterBatch }
    let errors = Errors(), queue = TransactionCoordinator<String>()
    let receipt = try await queue.submit(.init(name: "observer.periodic", operate: {
        throw LiveFailure.staleWorkspaceAfterBatch
    }, reportInternalError: { await errors.append($0) }))
    #expect(receipt.transaction.failure?.message == "transaction execution failed")
    #expect(await errors.values == ["staleWorkspaceAfterBatch"])
}

@Test func queueAndHistoryAreBounded() async throws {
    let queue = TransactionCoordinator<String>(pendingLimit: 2, historyLimit: 2)
    await queue.beginRecovery(reason: "test")
    _ = try await queue.submit(.init(name: "a", operate: { .init(result: "a", committedStateVersion: 1) }), mode: .instant)
    _ = try await queue.submit(.init(name: "b", operate: { .init(result: "b", committedStateVersion: 1) }), mode: .instant)
    await #expect(throws: TransactionCoordinatorError.queueFull) {
        try await queue.submit(.init(name: "c", operate: { .init(result: "c", committedStateVersion: 1) }), mode: .instant)
    }
    await queue.endRecovery(success: true)
}

@Test func recoveryFailureFailsQueuedWithStructuredError() async throws {
    let queue = TransactionCoordinator<String>()
    await queue.beginRecovery(reason: "resume")
    let accepted = try await queue.submit(.init(name: "focus", operate: { .init(result: "never", committedStateVersion: 0) }), mode: .instant)
    await queue.endRecovery(success: false, failure: .init(code: .permissionDenied, message: "permission unavailable", retryable: true))
    let status = try await queue.status(accepted.transaction.transactionId)
    #expect(status.transaction.phase == .failed)
    #expect(status.transaction.failure?.code == .permissionDenied)
    #expect(!(await queue.metadata().recovery.active))

    let next = try await queue.submit(.init(name: "next", operate: {
        .init(result: "released", committedStateVersion: 1)
    }))
    #expect(next.result == "released")
}

@Test func sequentialBatchStopsAfterFailedReceipt() async throws {
    let probe = Probe(), queue = TransactionCoordinator<String>()
    let receipts = try await queue.batch([
        .init(name: "one", operate: { await probe.run("one") }),
        .init(name: "two", operate: { throw TransactionFailure(code: .windowNotFound, message: "missing") }),
        .init(name: "three", operate: { await probe.run("three") }),
    ])
    #expect(receipts.count == 2)
    #expect(receipts.last?.transaction.failure?.code == .windowNotFound)
    #expect(await probe.order == ["one"])
}

@Test func bulkIsBoundedDeterministicAndSanitized() async throws {
    let command = try atomicBulkCommand(name: "bulk", windowIDs: ["b", "a", "b"], committedStateVersion: { 7 }, desired: { _ in }, operate: { id in
        if id == "b" { throw CocoaError(.fileReadNoPermission) }
        return id
    })
    let receipt = try await TransactionCoordinator<BulkTransactionResult>().submit(command)
    #expect(receipt.result?.windowIds == ["a", "b"])
    #expect(receipt.result?.failures.first?.failure.message == "window operation failed")
}

@Test func timeoutDoesNotDeadlockFollowingWork() async throws {
    let queue = TransactionCoordinator<String>(timeout: .milliseconds(100))
    let first = Task { try await queue.submit(.init(name: "hung", operate: {
        while true { try? await Task.sleep(for: .seconds(1)) }
    })) }
    #expect(try await first.value.transaction.failure?.code == .notReady)
    let second = try await queue.submit(.init(name: "next", operate: {
        .init(result: "next", committedStateVersion: 2)
    }))
    #expect(second.result == "next")
}

private extension Array {
    func asyncMap<T>(_ transform: (Element) async throws -> T) async rethrows -> [T] {
        var values: [T] = []; for element in self { values.append(try await transform(element)) }; return values
    }
}
