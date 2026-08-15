import Foundation
import WMProtocol

private final class TransactionRace<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var finished = false
    func resume(_ continuation: CheckedContinuation<Value, Error>, with result: Result<Value, Error>) {
        lock.lock(); defer { lock.unlock() }
        guard !finished else { return }
        finished = true; continuation.resume(with: result)
    }
}

public struct TransactionOutcome<Result: Codable & Equatable & Sendable>: Sendable {
    public var result: Result
    public var committedStateVersion: UInt64
    public init(result: Result, committedStateVersion: UInt64) {
        self.result = result; self.committedStateVersion = committedStateVersion
    }
}

public struct TransactionCommand<Result: Codable & Equatable & Sendable>: Sendable {
    public var name: String
    public var idempotencyKey: String?
    public var authorize: @Sendable () async -> TransactionFailure?
    public var desired: @Sendable () async throws -> Void
    public var observe: @Sendable () async throws -> Void
    public var operate: @Sendable () async throws -> TransactionOutcome<Result>
    public var commit: @Sendable (TransactionOutcome<Result>) async throws -> Void
    public var escalate: @Sendable () async throws -> Void
    public var reportInternalError: @Sendable (String) async -> Void

    public init(name: String, idempotencyKey: String? = nil,
                authorize: @escaping @Sendable () async -> TransactionFailure? = { nil },
                desired: @escaping @Sendable () async throws -> Void = {},
                observe: @escaping @Sendable () async throws -> Void = {},
                operate: @escaping @Sendable () async throws -> TransactionOutcome<Result>,
                commit: @escaping @Sendable (TransactionOutcome<Result>) async throws -> Void = { _ in },
                escalate: @escaping @Sendable () async throws -> Void = {},
                reportInternalError: @escaping @Sendable (String) async -> Void = { _ in }) {
        self.name = name; self.idempotencyKey = idempotencyKey; self.authorize = authorize
        self.desired = desired; self.observe = observe; self.operate = operate
        self.commit = commit; self.escalate = escalate
        self.reportInternalError = reportInternalError
    }
}

public enum TransactionCoordinatorError: Error, Equatable, Sendable {
    case unknownTransaction(String), queueFull, invalidBatch, invalidBulk
}

public actor TransactionCoordinator<Result: Codable & Equatable & Sendable> {
    private typealias Waiter = CheckedContinuation<TransactionReceipt<Result>, Never>
    private struct Work: Sendable { let id: String; let command: TransactionCommand<Result>; let deadline: ContinuousClock.Instant }
    private let now: @Sendable () -> Date
    private let makeID: @Sendable () -> String
    private let suspiciousThreshold: Int, pendingLimit: Int, historyLimit: Int
    private let timeout: Duration
    private var queue: [Work] = [], queueHead = 0
    private var records: [String: TransactionMetadata] = [:]
    private var terminalResults: [String: Result] = [:]
    private var terminalOrder: [String] = []
    private var pending: Set<String> = [], coalescing: [String: String] = [:]
    private var waiters: [String: [UUID: Waiter]] = [:]
    private var escalationDecided: Set<String> = []
    private var draining = false, recoveryReason: String?

    public init(suspiciousThreshold: Int = 3, pendingLimit: Int = 256, historyLimit: Int = 512,
                timeout: Duration = .seconds(15), now: @escaping @Sendable () -> Date = Date.init,
                makeID: @escaping @Sendable () -> String = { UUID().uuidString }) {
        self.suspiciousThreshold = max(2, suspiciousThreshold); self.pendingLimit = max(1, pendingLimit)
        self.historyLimit = max(1, historyLimit); self.timeout = timeout; self.now = now; self.makeID = makeID
    }

    public func submit(_ command: TransactionCommand<Result>, mode: TransactionReturnMode = .completion) async throws -> TransactionReceipt<Result> {
        let id = try enqueue(command)
        if mode == .instant { return .init(transaction: records[id]!) }
        return await waitForCompletion(id)
    }

    public func status(_ id: String) throws -> TransactionReceipt<Result> {
        guard let record = records[id] else { throw TransactionCoordinatorError.unknownTransaction(id) }
        return .init(transaction: record, result: terminalResults[id])
    }

    public func batch(_ commands: [TransactionCommand<Result>]) async throws -> [TransactionReceipt<Result>] {
        guard !commands.isEmpty, commands.count <= 64 else { throw TransactionCoordinatorError.invalidBatch }
        var receipts: [TransactionReceipt<Result>] = []
        for command in commands {
            let receipt = try await submit(command)
            receipts.append(receipt)
            if receipt.transaction.phase == .failed { break }
        }
        return receipts
    }

    public func metadata() -> TransactionQueryMetadata {
        let values = pending.compactMap { records[$0] }.sorted { $0.acceptedAt < $1.acceptedAt }
        return .init(pendingTransactions: values,
                     recovery: .init(active: recoveryReason != nil, reason: recoveryReason, queuedTransactions: max(0, queue.count - queueHead)))
    }

    public func beginRecovery(reason: String) { recoveryReason = String(reason.prefix(128)) }
    public func endRecovery(success: Bool, failure: TransactionFailure? = nil) {
        if success { recoveryReason = nil; startDrain() }
        else { failQueued(failure ?? .init(code: .notReady, message: "recovery failed", retryable: true)) }
    }

    public func cancelQueued() { failQueued(.init(code: .notReady, message: "daemon is terminating")) }

    private func enqueue(_ command: TransactionCommand<Result>) throws -> String {
        if let key = command.idempotencyKey, let id = coalescing[key] {
            let count = min(records[id]!.coalescedRequests + 1, 1_000_000)
            records[id]!.coalescedRequests = count
            if count + 1 >= suspiciousThreshold, !escalationDecided.contains(id) {
                records[id]!.reconciliationEscalated = true
            }
            return id
        }
        guard pending.count < pendingLimit else { throw TransactionCoordinatorError.queueFull }
        let id = makeID(), deadline = ContinuousClock.now.advanced(by: timeout)
        queue.append(.init(id: id, command: command, deadline: deadline)); pending.insert(id)
        records[id] = .init(transactionId: id, phase: .queued, command: command.name, acceptedAt: now())
        if let key = command.idempotencyKey { coalescing[key] = id }
        startDrain(); return id
    }

    private func waitForCompletion(_ id: String) async -> TransactionReceipt<Result> {
        if !pending.contains(id) { return (try? status(id)) ?? .init(transaction: records[id]!) }
        let waiterID = UUID()
        return await withTaskCancellationHandler(operation: {
            await withCheckedContinuation { waiters[id, default: [:]][waiterID] = $0 }
        }, onCancel: { Task { await self.cancelWaiter(id: id, waiterID: waiterID) } })
    }

    private func cancelWaiter(id: String, waiterID: UUID) {
        guard let waiter = waiters[id]?.removeValue(forKey: waiterID), let record = records[id] else { return }
        waiter.resume(returning: .init(transaction: record))
        if waiters[id]?.isEmpty == true { waiters.removeValue(forKey: id) }
    }

    private func startDrain() {
        guard !draining, recoveryReason == nil, queueHead < queue.count else { return }
        draining = true; Task { await drain() }
    }

    private func drain() async {
        while recoveryReason == nil, queueHead < queue.count {
            let work = queue[queueHead]; queueHead += 1
            if queueHead > 128, queueHead * 2 > queue.count { queue.removeFirst(queueHead); queueHead = 0 }
            guard pending.contains(work.id) else { continue }
            records[work.id]!.phase = .running
            let receipt = await execute(work)
            finish(work, receipt)
            await Task.yield()
        }
        draining = false
        if recoveryReason == nil, queueHead < queue.count { startDrain() }
    }

    private func execute(_ work: Work) async -> TransactionReceipt<Result> {
        if let failure = await work.command.authorize() { return failed(work.id, failure) }
        guard ContinuousClock.now < work.deadline else { return failed(work.id, timeoutFailure) }
        do {
            try await work.command.desired()
            try await work.command.observe()
            escalationDecided.insert(work.id)
            if records[work.id]?.reconciliationEscalated == true { try await work.command.escalate() }
            let operation = Task { try await work.command.operate() }
            let outcome = try await withCheckedThrowingContinuation { continuation in
                let race = TransactionRace<TransactionOutcome<Result>>()
                Task {
                    do { race.resume(continuation, with: .success(try await operation.value)) }
                    catch { race.resume(continuation, with: .failure(error)) }
                }
                Task {
                    try? await Task.sleep(until: work.deadline)
                    operation.cancel()
                    race.resume(continuation, with: .failure(TransactionFailure(
                        code: .notReady, message: "transaction timed out", retryable: true
                    )))
                }
            }
            if let failure = await work.command.authorize() { return failed(work.id, failure) }
            try await work.command.commit(outcome)
            var record = records[work.id]!; record.phase = .committed; record.completedAt = now()
            record.committedStateVersion = outcome.committedStateVersion
            return .init(transaction: record, result: outcome.result)
        } catch let failure as TransactionFailure { return failed(work.id, failure) }
        catch {
            await work.command.reportInternalError(String(describing: error))
            return failed(work.id, .init(code: .internalError, message: "transaction execution failed", retryable: true))
        }
    }

    private var timeoutFailure: TransactionFailure { .init(code: .notReady, message: "transaction timed out", retryable: true) }
    private func failed(_ id: String, _ failure: TransactionFailure) -> TransactionReceipt<Result> {
        var record = records[id]!; record.phase = .failed; record.completedAt = now(); record.failure = failure
        return .init(transaction: record)
    }

    private func finish(_ work: Work, _ receipt: TransactionReceipt<Result>) {
        records[work.id] = receipt.transaction; terminalResults[work.id] = receipt.result
        pending.remove(work.id); if let key = work.command.idempotencyKey { coalescing.removeValue(forKey: key) }
        escalationDecided.remove(work.id)
        for waiter in waiters.removeValue(forKey: work.id)?.values ?? [:].values { waiter.resume(returning: receipt) }
        terminalOrder.append(work.id); trimHistory()
    }

    private func failQueued(_ failure: TransactionFailure) {
        recoveryReason = nil
        while queueHead < queue.count {
            let work = queue[queueHead]; queueHead += 1
            guard pending.contains(work.id) else { continue }
            finish(work, failed(work.id, failure))
        }
        queue.removeAll(keepingCapacity: true); queueHead = 0
    }

    private func trimHistory() {
        while terminalOrder.count > historyLimit {
            let id = terminalOrder.removeFirst(); records.removeValue(forKey: id); terminalResults.removeValue(forKey: id)
        }
    }
}

public func atomicBulkCommand<Result: Codable & Equatable & Sendable>(
    name: String, windowIDs: [String], committedStateVersion: @escaping @Sendable () async -> UInt64,
    desired: @escaping @Sendable ([String]) async throws -> Void,
    operate: @escaping @Sendable (String) async throws -> Result,
    failure: @escaping @Sendable (Error) -> TransactionFailure = { _ in
        .init(code: .internalError, message: "window operation failed", retryable: true)
    }
) throws -> TransactionCommand<BulkTransactionResult> {
    guard !windowIDs.isEmpty, windowIDs.count <= 128,
          windowIDs.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 256 }) else { throw TransactionCoordinatorError.invalidBulk }
    let ids = Array(Set(windowIDs)).sorted()
    return TransactionCommand(name: name, desired: { try await desired(ids) }, operate: {
        var failures: [BulkItemFailure] = []
        for id in ids {
            try Task.checkCancellation()
            do { _ = try await operate(id) }
            catch { failures.append(.init(windowId: id, failure: failure(error))) }
        }
        return .init(result: .init(windowIds: ids, failures: failures), committedStateVersion: await committedStateVersion())
    })
}
