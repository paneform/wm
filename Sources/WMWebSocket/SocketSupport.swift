import Darwin
import Foundation

public enum WebSocketTransportError: Error, CustomStringConvertible, Sendable {
    case invalidURL
    case resolutionFailed(String)
    case socketFailed(String)
    case bindFailed(host: String, port: UInt16, reason: String)
    case connectFailed(String)
    case handshakeFailed(String)
    case closed
    case outboundQueueFull

    public var description: String {
        switch self {
        case .invalidURL: "invalid WebSocket URL"
        case let .resolutionFailed(reason): "address resolution failed: \(reason)"
        case let .socketFailed(reason): "socket failed: \(reason)"
        case let .bindFailed(host, port, reason): "cannot bind \(host):\(port): \(reason)"
        case let .connectFailed(reason): "connection failed: \(reason)"
        case let .handshakeFailed(reason): "WebSocket handshake failed: \(reason)"
        case .closed: "WebSocket connection closed"
        case .outboundQueueFull: "WebSocket outbound queue is full"
        }
    }
}

enum SocketSupport {
    static let stream = SOCK_STREAM

    static func endpoints(host: String, port: UInt16, passive: Bool) throws -> UnsafeMutablePointer<addrinfo> {
        var hints = addrinfo()
        hints.ai_flags = passive ? AI_PASSIVE : 0
        hints.ai_family = AF_UNSPEC
        hints.ai_socktype = stream
        hints.ai_protocol = IPPROTO_TCP
        var result: UnsafeMutablePointer<addrinfo>?
        let status = getaddrinfo(host, String(port), &hints, &result)
        guard status == 0, let result else {
            throw WebSocketTransportError.resolutionFailed(String(cString: gai_strerror(status)))
        }
        return result
    }

    static func errorText(_ code: Int32 = errno) -> String { String(cString: strerror(code)) }

    static func writeAll(_ data: Data, to descriptor: Int32) throws {
        var offset = 0
        while offset < data.count {
            let written = data.withUnsafeBytes { bytes in
                Darwin.send(descriptor, bytes.baseAddress!.advanced(by: offset), data.count - offset, 0)
            }
            if written > 0 { offset += written; continue }
            if written < 0 && errno == EINTR { continue }
            throw WebSocketTransportError.closed
        }
    }

    static func randomKey() -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        arc4random_buf(&bytes, bytes.count)
        return Data(bytes).base64EncodedString()
    }
}
