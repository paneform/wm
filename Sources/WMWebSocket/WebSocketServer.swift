import Darwin
import Dispatch
import Foundation

public protocol WebSocketRequestHandler: Sendable {
    func connected(clientID: UUID) async -> [String]
    func handle(text: String, clientID: UUID) async -> [String]
    func disconnected(clientID: UUID) async
}

public extension WebSocketRequestHandler {
    func connected(clientID: UUID) async -> [String] { [] }
    func disconnected(clientID: UUID) async {}
}

public struct WebSocketServerConfiguration: Sendable {
    public var host: String
    public var port: UInt16
    public var path: String
    public var allowedOrigins: Set<String>
    public var maximumInboundBytes: Int
    public var outboundQueueLimit: Int

    public init(
        host: String = "127.0.0.1",
        port: UInt16 = 17_832,
        path: String = "/v1",
        allowedOrigins: Set<String> = [],
        maximumInboundBytes: Int = WebSocketFrameDecoder.maximumMessageBytes,
        outboundQueueLimit: Int = 256
    ) {
        self.host = host
        self.port = port
        self.path = path
        self.allowedOrigins = allowedOrigins
        self.maximumInboundBytes = maximumInboundBytes
        self.outboundQueueLimit = outboundQueueLimit
    }
}

public final class WebSocketServer: @unchecked Sendable {
    public let configuration: WebSocketServerConfiguration
    private let handler: any WebSocketRequestHandler
    private let lock = NSLock()
    private var listener: Int32 = -1
    private var clients: [UUID: ServerConnection] = [:]
    private var running = false

    public init(configuration: WebSocketServerConfiguration = .init(), handler: any WebSocketRequestHandler) {
        self.configuration = configuration
        self.handler = handler
    }

    deinit { stop() }

    public func start() throws {
        lock.lock()
        defer { lock.unlock() }
        guard !running else { return }
        listener = try makeListener()
        running = true
        let descriptor = listener
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in self?.acceptLoop(descriptor) }
    }

    public func stop() {
        lock.lock()
        guard running else { lock.unlock(); return }
        running = false
        let descriptor = listener
        listener = -1
        let connections = Array(clients.values)
        clients.removeAll()
        lock.unlock()
        if descriptor >= 0 { shutdown(descriptor, SHUT_RDWR); close(descriptor) }
        connections.forEach { $0.close() }
    }

    public func send(_ text: String, to clientID: UUID) throws {
        lock.lock(); let connection = clients[clientID]; lock.unlock()
        guard let connection else { throw WebSocketTransportError.closed }
        try connection.enqueue(WebSocketFrame(text: text))
    }

    public func broadcast(_ text: String) {
        lock.lock(); let connections = Array(clients.values); lock.unlock()
        for connection in connections { try? connection.enqueue(WebSocketFrame(text: text)) }
    }

    private func makeListener() throws -> Int32 {
        let addresses = try SocketSupport.endpoints(host: configuration.host, port: configuration.port, passive: true)
        defer { freeaddrinfo(addresses) }
        var address: UnsafeMutablePointer<addrinfo>? = addresses
        var lastError = "no compatible address"
        while let current = address {
            let info = current.pointee
            let descriptor = socket(info.ai_family, info.ai_socktype, info.ai_protocol)
            if descriptor >= 0 {
                var one: Int32 = 1
                setsockopt(descriptor, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout.size(ofValue: one)))
                if bind(descriptor, info.ai_addr, info.ai_addrlen) == 0 && listen(descriptor, SOMAXCONN) == 0 {
                    return descriptor
                }
                lastError = SocketSupport.errorText()
                close(descriptor)
            } else { lastError = SocketSupport.errorText() }
            address = current.pointee.ai_next
        }
        throw WebSocketTransportError.bindFailed(host: configuration.host, port: configuration.port, reason: lastError)
    }

    private func acceptLoop(_ descriptor: Int32) {
        while true {
            let client = accept(descriptor, nil, nil)
            if client < 0 {
                lock.lock(); let active = running; lock.unlock()
                if !active { return }
                if errno == EINTR { continue }
                continue
            }
            let connection = ServerConnection(
                descriptor: client,
                configuration: configuration,
                handler: handler,
                onReady: { [weak self] connection in self?.add(connection) },
                onClose: { [weak self] id in self?.remove(id) }
            )
            connection.start()
        }
    }

    private func add(_ connection: ServerConnection) {
        lock.lock(); clients[connection.id] = connection; lock.unlock()
    }

    private func remove(_ id: UUID) {
        lock.lock(); clients.removeValue(forKey: id); lock.unlock()
    }
}

private final class ServerConnection: @unchecked Sendable {
    let id = UUID()
    private let descriptor: Int32
    private let configuration: WebSocketServerConfiguration
    private let handler: any WebSocketRequestHandler
    private let onReady: @Sendable (ServerConnection) -> Void
    private let onClose: @Sendable (UUID) -> Void
    private let condition = NSCondition()
    private var queue: [Data] = []
    private var closed = false

    init(descriptor: Int32, configuration: WebSocketServerConfiguration, handler: any WebSocketRequestHandler,
         onReady: @escaping @Sendable (ServerConnection) -> Void, onClose: @escaping @Sendable (UUID) -> Void) {
        self.descriptor = descriptor
        self.configuration = configuration
        self.handler = handler
        self.onReady = onReady
        self.onClose = onClose
    }

    func start() {
        DispatchQueue.global(qos: .userInitiated).async { [self] in readLoop() }
    }

    func enqueue(_ frame: WebSocketFrame) throws {
        condition.lock()
        guard !closed else { condition.unlock(); throw WebSocketTransportError.closed }
        guard queue.count < configuration.outboundQueueLimit else {
            condition.unlock(); close(); throw WebSocketTransportError.outboundQueueFull
        }
        queue.append(frame.encoded(masked: false))
        condition.signal()
        condition.unlock()
    }

    func close() {
        condition.lock()
        guard !closed else { condition.unlock(); return }
        closed = true
        condition.broadcast()
        condition.unlock()
        shutdown(descriptor, SHUT_RDWR)
        Darwin.close(descriptor)
    }

    private func readLoop() {
        defer {
            close(); onClose(id)
            Task { await handler.disconnected(clientID: id) }
        }
        do {
            let remaining = try performHandshake()
            onReady(self)
            DispatchQueue.global(qos: .utility).async { [self] in writeLoop() }
            Task {
                for message in await handler.connected(clientID: id) { try? enqueue(WebSocketFrame(text: message)) }
            }
            var decoder = WebSocketFrameDecoder(expectsMasked: true, maximumMessageBytes: configuration.maximumInboundBytes)
            if !remaining.isEmpty { try process(try decoder.append(remaining)) }
            var bytes = [UInt8](repeating: 0, count: 16 * 1024)
            while true {
                let count = recv(descriptor, &bytes, bytes.count, 0)
                if count <= 0 { return }
                try process(try decoder.append(Data(bytes.prefix(count))))
            }
        } catch {
            sendClose(code: 1002)
        }
    }

    private func performHandshake() throws -> Data {
        var request = Data()
        var bytes = [UInt8](repeating: 0, count: 4096)
        while request.range(of: Data("\r\n\r\n".utf8)) == nil {
            guard request.count <= WebSocketHandshake.maximumHeaderBytes else { throw WebSocketHandshakeError.malformedRequest }
            let count = recv(descriptor, &bytes, bytes.count, 0)
            guard count > 0 else { throw WebSocketTransportError.closed }
            request.append(contentsOf: bytes.prefix(count))
        }
        let end = request.range(of: Data("\r\n\r\n".utf8))!.upperBound
        let handshake = try WebSocketHandshake(request: request[..<end], path: configuration.path, allowedOrigins: configuration.allowedOrigins)
        try SocketSupport.writeAll(handshake.response, to: descriptor)
        return Data(request[end...])
    }

    private func process(_ frames: [WebSocketFrame]) throws {
        for frame in frames {
            switch frame.opcode {
            case .text:
                guard let text = frame.text else { throw WebSocketFrameError.invalidUTF8 }
                Task {
                    for message in await handler.handle(text: text, clientID: id) { try? enqueue(WebSocketFrame(text: message)) }
                }
            case .ping: try enqueue(WebSocketFrame(opcode: .pong, payload: frame.payload))
            case .pong: break
            case .close: sendClose(code: 1000); close(); return
            case .continuation: throw WebSocketFrameError.protocolViolation
            }
        }
    }

    private func writeLoop() {
        while true {
            condition.lock()
            while queue.isEmpty && !closed { condition.wait() }
            if closed { condition.unlock(); return }
            let data = queue.removeFirst()
            condition.unlock()
            do { try SocketSupport.writeAll(data, to: descriptor) } catch { close(); return }
        }
    }

    private func sendClose(code: UInt16) {
        var value = code.bigEndian
        let payload = Data(bytes: &value, count: 2)
        try? SocketSupport.writeAll(WebSocketFrame(opcode: .close, payload: payload).encoded(masked: false), to: descriptor)
    }
}
