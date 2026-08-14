import Darwin
import Foundation

public final class WebSocketClient: @unchecked Sendable {
    public let url: URL
    private let origin: String?
    private let lock = NSLock()
    private var descriptor: Int32 = -1
    private var decoder = WebSocketFrameDecoder(expectsMasked: false)
    private var pendingFrames: [WebSocketFrame] = []

    public init(url: URL, origin: String? = nil) {
        self.url = url
        self.origin = origin
    }

    deinit { close() }

    public func connect() throws {
        guard url.scheme == "ws", let host = url.host, url.user == nil, url.password == nil else {
            throw WebSocketTransportError.invalidURL
        }
        let port = UInt16(url.port ?? 80)
        let socket = try connectSocket(host: host, port: port)
        do {
            let key = SocketSupport.randomKey()
            var request = "GET \(url.path.isEmpty ? "/" : url.path) HTTP/1.1\r\nHost: \(host):\(port)\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: \(key)\r\nSec-WebSocket-Version: 13\r\n"
            if let origin { request += "Origin: \(origin)\r\n" }
            request += "\r\n"
            try SocketSupport.writeAll(Data(request.utf8), to: socket)
            let remainder = try readHandshake(from: socket, expectedAccept: WebSocketHandshake.acceptValue(for: key))
            lock.lock(); descriptor = socket; lock.unlock()
            if !remainder.isEmpty { pendingFrames = try decoder.append(remainder) }
        } catch {
            Darwin.close(socket)
            throw error
        }
    }

    public func send(text: String) throws {
        try send(frame: WebSocketFrame(text: text))
    }

    public func receive() throws -> String {
        while true {
            if !pendingFrames.isEmpty {
                let frame = pendingFrames.removeFirst()
                switch frame.opcode {
                case .text: return frame.text!
                case .ping: try send(frame: WebSocketFrame(opcode: .pong, payload: frame.payload))
                case .pong: continue
                case .close: close(); throw WebSocketTransportError.closed
                case .continuation: continue
                }
            }
            let socket = try currentDescriptor()
            var bytes = [UInt8](repeating: 0, count: 16 * 1024)
            let count = recv(socket, &bytes, bytes.count, 0)
            guard count > 0 else { close(); throw WebSocketTransportError.closed }
            pendingFrames.append(contentsOf: try decoder.append(Data(bytes.prefix(count))))
        }
    }

    public func close() {
        lock.lock()
        let socket = descriptor
        descriptor = -1
        lock.unlock()
        guard socket >= 0 else { return }
        try? SocketSupport.writeAll(WebSocketFrame(opcode: .close).encoded(masked: true), to: socket)
        shutdown(socket, SHUT_RDWR)
        Darwin.close(socket)
    }

    private func send(frame: WebSocketFrame) throws {
        try SocketSupport.writeAll(frame.encoded(masked: true), to: currentDescriptor())
    }

    private func currentDescriptor() throws -> Int32 {
        lock.lock(); defer { lock.unlock() }
        guard descriptor >= 0 else { throw WebSocketTransportError.closed }
        return descriptor
    }

    private func connectSocket(host: String, port: UInt16) throws -> Int32 {
        let addresses = try SocketSupport.endpoints(host: host, port: port, passive: false)
        defer { freeaddrinfo(addresses) }
        var address: UnsafeMutablePointer<addrinfo>? = addresses
        var lastError = "no compatible address"
        while let current = address {
            let info = current.pointee
            let candidate = socket(info.ai_family, info.ai_socktype, info.ai_protocol)
            if candidate >= 0 {
                if Darwin.connect(candidate, info.ai_addr, info.ai_addrlen) == 0 { return candidate }
                lastError = SocketSupport.errorText(); Darwin.close(candidate)
            }
            address = current.pointee.ai_next
        }
        throw WebSocketTransportError.connectFailed(lastError)
    }

    private func readHandshake(from socket: Int32, expectedAccept: String) throws -> Data {
        var response = Data()
        var bytes = [UInt8](repeating: 0, count: 4096)
        let delimiter = Data("\r\n\r\n".utf8)
        while response.range(of: delimiter) == nil {
            guard response.count <= WebSocketHandshake.maximumHeaderBytes else {
                throw WebSocketTransportError.handshakeFailed("headers too large")
            }
            let count = recv(socket, &bytes, bytes.count, 0)
            guard count > 0 else { throw WebSocketTransportError.closed }
            response.append(contentsOf: bytes.prefix(count))
        }
        let end = response.range(of: delimiter)!.upperBound
        guard let header = String(data: response[..<end], encoding: .utf8) else {
            throw WebSocketTransportError.handshakeFailed("invalid response")
        }
        let lines = header.components(separatedBy: "\r\n")
        guard lines.first == "HTTP/1.1 101 Switching Protocols" else {
            throw WebSocketTransportError.handshakeFailed(lines.first ?? "empty response")
        }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() where !line.isEmpty {
            guard let separator = line.firstIndex(of: ":") else { continue }
            headers[line[..<separator].lowercased()] = line[line.index(after: separator)...].trimmingCharacters(in: .whitespaces)
        }
        let connectionTokens = headers["connection"]?.lowercased().split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) } ?? []
        guard headers["upgrade"]?.lowercased() == "websocket",
              connectionTokens.contains("upgrade"),
              headers["sec-websocket-accept"] == expectedAccept else {
            throw WebSocketTransportError.handshakeFailed("invalid upgrade response")
        }
        return Data(response[end...])
    }
}
