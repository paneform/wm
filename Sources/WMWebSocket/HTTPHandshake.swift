import Foundation

public enum WebSocketHandshakeError: Error, Equatable, Sendable {
    case incomplete
    case malformedRequest
    case invalidMethod
    case invalidPath
    case invalidUpgrade
    case invalidVersion
    case missingKey
    case originDenied
}

public struct WebSocketHandshake: Sendable {
    public static let maximumHeaderBytes = 16 * 1024

    public let path: String
    public let headers: [String: String]

    public init(request: Data, path: String = "/v1", allowedOrigins: Set<String> = []) throws {
        guard request.count <= Self.maximumHeaderBytes else { throw WebSocketHandshakeError.malformedRequest }
        guard let text = String(data: request, encoding: .utf8), text.hasSuffix("\r\n\r\n") else {
            throw WebSocketHandshakeError.incomplete
        }

        let lines = text.components(separatedBy: "\r\n")
        let requestLine = lines[0].split(separator: " ", omittingEmptySubsequences: true)
        guard requestLine.count == 3 else { throw WebSocketHandshakeError.malformedRequest }
        guard requestLine[0] == "GET" else { throw WebSocketHandshakeError.invalidMethod }
        guard requestLine[1] == Substring(path) else { throw WebSocketHandshakeError.invalidPath }
        guard requestLine[2] == "HTTP/1.1" else { throw WebSocketHandshakeError.malformedRequest }

        var parsed: [String: String] = [:]
        for line in lines.dropFirst() where !line.isEmpty {
            guard let separator = line.firstIndex(of: ":") else { throw WebSocketHandshakeError.malformedRequest }
            let name = line[..<separator].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: separator)...].trimmingCharacters(in: .whitespaces)
            guard !name.isEmpty, parsed[name] == nil else { throw WebSocketHandshakeError.malformedRequest }
            parsed[name] = value
        }

        guard parsed["upgrade"]?.lowercased() == "websocket",
              Self.tokens(parsed["connection"]).contains("upgrade") else {
            throw WebSocketHandshakeError.invalidUpgrade
        }
        guard parsed["sec-websocket-version"] == "13" else { throw WebSocketHandshakeError.invalidVersion }
        guard let key = parsed["sec-websocket-key"],
              let decoded = Data(base64Encoded: key), decoded.count == 16 else {
            throw WebSocketHandshakeError.missingKey
        }
        if let origin = parsed["origin"], !allowedOrigins.contains(origin) {
            throw WebSocketHandshakeError.originDenied
        }

        self.path = path
        self.headers = parsed
    }

    public var response: Data {
        let accept = Self.acceptValue(for: headers["sec-websocket-key"]!)
        return Data("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n\r\n".utf8)
    }

    public static func acceptValue(for key: String) -> String {
        SHA1.hash(Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8)).base64EncodedString()
    }

    private static func tokens(_ value: String?) -> Set<String> {
        Set((value ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces).lowercased() })
    }
}

private enum SHA1 {
    static func hash(_ data: Data) -> Data {
        var message = [UInt8](data)
        let bitLength = UInt64(message.count) * 8
        message.append(0x80)
        while message.count % 64 != 56 { message.append(0) }
        message.append(contentsOf: withUnsafeBytes(of: bitLength.bigEndian, Array.init))

        var h0: UInt32 = 0x67452301
        var h1: UInt32 = 0xEFCDAB89
        var h2: UInt32 = 0x98BADCFE
        var h3: UInt32 = 0x10325476
        var h4: UInt32 = 0xC3D2E1F0

        for offset in stride(from: 0, to: message.count, by: 64) {
            var words = [UInt32](repeating: 0, count: 80)
            for index in 0..<16 {
                let start = offset + index * 4
                words[index] = UInt32(message[start]) << 24 | UInt32(message[start + 1]) << 16
                    | UInt32(message[start + 2]) << 8 | UInt32(message[start + 3])
            }
            for index in 16..<80 {
                words[index] = rotate(words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16], by: 1)
            }

            var a = h0, b = h1, c = h2, d = h3, e = h4
            for index in 0..<80 {
                let f: UInt32
                let k: UInt32
                switch index {
                case 0..<20: (f, k) = ((b & c) | ((~b) & d), 0x5A827999)
                case 20..<40: (f, k) = (b ^ c ^ d, 0x6ED9EBA1)
                case 40..<60: (f, k) = ((b & c) | (b & d) | (c & d), 0x8F1BBCDC)
                default: (f, k) = (b ^ c ^ d, 0xCA62C1D6)
                }
                let temporary = rotate(a, by: 5) &+ f &+ e &+ k &+ words[index]
                e = d; d = c; c = rotate(b, by: 30); b = a; a = temporary
            }
            h0 &+= a; h1 &+= b; h2 &+= c; h3 &+= d; h4 &+= e
        }

        var result = Data()
        for word in [h0, h1, h2, h3, h4] {
            var value = word.bigEndian
            result.append(Data(bytes: &value, count: 4))
        }
        return result
    }

    private static func rotate(_ value: UInt32, by count: UInt32) -> UInt32 {
        (value << count) | (value >> (32 - count))
    }
}
