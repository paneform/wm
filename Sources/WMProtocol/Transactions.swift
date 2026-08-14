import Foundation

public enum TransactionReturnMode: String, Codable, Sendable { case completion, instant }
public enum TransactionPhase: String, Codable, Sendable { case queued, running, committed, failed }

public struct TransactionFailure: Codable, Equatable, Error, Sendable {
    public var code: ErrorCode
    public var message: String
    public var retryable: Bool
    public var details: [String: JSONValue]
    public init(code: ErrorCode, message: String, retryable: Bool = false, details: [String: JSONValue] = [:]) {
        self.code = code; self.message = String(message.prefix(256)); self.retryable = retryable; self.details = details
    }
    public init(_ error: ProtocolError) {
        self.init(code: error.code, message: error.message, retryable: error.retryable, details: error.details)
    }
    public var protocolError: ProtocolError { .init(code: code, message: message, retryable: retryable, details: details) }
}

public struct TransactionMetadata: Codable, Equatable, Sendable {
    public var transactionId: String
    public var phase: TransactionPhase
    public var command: String
    public var acceptedAt: Date
    public var completedAt: Date?
    public var committedStateVersion: UInt64?
    public var coalescedRequests: Int
    public var reconciliationEscalated: Bool
    public var failure: TransactionFailure?

    public init(transactionId: String, phase: TransactionPhase, command: String, acceptedAt: Date,
                completedAt: Date? = nil, committedStateVersion: UInt64? = nil,
                coalescedRequests: Int = 0, reconciliationEscalated: Bool = false,
                failure: TransactionFailure? = nil) {
        self.transactionId = transactionId; self.phase = phase; self.command = command
        self.acceptedAt = acceptedAt; self.completedAt = completedAt; self.committedStateVersion = committedStateVersion
        self.coalescedRequests = coalescedRequests; self.reconciliationEscalated = reconciliationEscalated
        self.failure = failure
    }
}

public struct RecoveryMetadata: Codable, Equatable, Sendable {
    public var active: Bool; public var reason: String?; public var queuedTransactions: Int
    public init(active: Bool, reason: String? = nil, queuedTransactions: Int = 0) {
        self.active = active; self.reason = reason; self.queuedTransactions = queuedTransactions
    }
}

public struct TransactionQueryMetadata: Codable, Equatable, Sendable {
    public var pendingTransactions: [TransactionMetadata]; public var recovery: RecoveryMetadata
    public init(pendingTransactions: [TransactionMetadata], recovery: RecoveryMetadata) {
        self.pendingTransactions = pendingTransactions; self.recovery = recovery
    }
}

public struct TransactionReceipt<Result: Codable & Equatable & Sendable>: Codable, Equatable, Sendable {
    public var transaction: TransactionMetadata; public var result: Result?
    public init(transaction: TransactionMetadata, result: Result? = nil) { self.transaction = transaction; self.result = result }
}

public struct BulkItemFailure: Codable, Equatable, Sendable {
    public var windowId: String; public var failure: TransactionFailure
    public init(windowId: String, failure: TransactionFailure) { self.windowId = windowId; self.failure = failure }
}

public struct BulkTransactionResult: Codable, Equatable, Sendable {
    public var windowIds: [String]; public var failures: [BulkItemFailure]
    public init(windowIds: [String], failures: [BulkItemFailure]) { self.windowIds = windowIds; self.failures = failures }
}

public struct BatchRequest: Codable, Equatable, Sendable {
    public var commands: [BatchCommand]
    public init(commands: [BatchCommand]) { self.commands = commands }
}
public struct BatchCommand: Codable, Equatable, Sendable {
    public var method: Method; public var params: [String: JSONValue]
    public init(method: Method, params: [String: JSONValue] = [:]) { self.method = method; self.params = params }
}
public struct BatchResult: Codable, Equatable, Sendable {
    public var results: [JSONValue]; public var stoppedAt: Int?
    public init(results: [JSONValue], stoppedAt: Int? = nil) { self.results = results; self.stoppedAt = stoppedAt }
}
