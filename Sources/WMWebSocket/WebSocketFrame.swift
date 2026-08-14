import Foundation

public enum WebSocketOpcode: UInt8, Sendable {
    case continuation = 0x0
    case text = 0x1
    case close = 0x8
    case ping = 0x9
    case pong = 0xA
}

public struct WebSocketFrame: Equatable, Sendable {
    public let opcode: WebSocketOpcode
    public let payload: Data

    public init(opcode: WebSocketOpcode, payload: Data = Data()) {
        self.opcode = opcode
        self.payload = payload
    }

    public init(text: String) {
        self.init(opcode: .text, payload: Data(text.utf8))
    }

    public var text: String? { String(data: payload, encoding: .utf8) }

    public func encoded(masked: Bool, maskingKey: UInt32 = UInt32.random(in: .min ... .max)) -> Data {
        var result = Data([0x80 | opcode.rawValue])
        let maskBit: UInt8 = masked ? 0x80 : 0
        switch payload.count {
        case 0...125:
            result.append(maskBit | UInt8(payload.count))
        case 126...65_535:
            result.append(maskBit | 126)
            var length = UInt16(payload.count).bigEndian
            result.append(Data(bytes: &length, count: 2))
        default:
            result.append(maskBit | 127)
            var length = UInt64(payload.count).bigEndian
            result.append(Data(bytes: &length, count: 8))
        }
        guard masked else { result.append(payload); return result }
        var key = maskingKey.bigEndian
        let keyData = withUnsafeBytes(of: &key) { Data($0) }
        result.append(keyData)
        result.append(Data(payload.enumerated().map { $0.element ^ keyData[$0.offset % 4] }))
        return result
    }
}

public enum WebSocketFrameError: Error, Equatable, Sendable {
    case protocolViolation
    case unmaskedClientFrame
    case maskedServerFrame
    case messageTooLarge
    case invalidUTF8
}

public struct WebSocketFrameDecoder: Sendable {
    public static let maximumMessageBytes = 1_048_576
    private var buffer = Data()
    private var fragmented = Data()
    private var fragmentOpcode: WebSocketOpcode?
    private let expectsMasked: Bool
    private let maximumMessageBytes: Int

    public init(expectsMasked: Bool, maximumMessageBytes: Int = Self.maximumMessageBytes) {
        self.expectsMasked = expectsMasked
        self.maximumMessageBytes = maximumMessageBytes
    }

    public mutating func append(_ data: Data) throws -> [WebSocketFrame] {
        buffer.append(data)
        if buffer.startIndex != 0 { buffer = Data(buffer) }
        var frames: [WebSocketFrame] = []
        while let parsed = try parseFrame() {
            buffer.removeFirst(parsed.consumed)
            let frame = parsed.frame
            if frame.opcode == .continuation {
                guard fragmentOpcode != nil else { throw WebSocketFrameError.protocolViolation }
                fragmented.append(frame.payload)
                guard fragmented.count <= maximumMessageBytes else { throw WebSocketFrameError.messageTooLarge }
                if parsed.final {
                    let complete = WebSocketFrame(opcode: fragmentOpcode!, payload: fragmented)
                    try validateText(complete)
                    frames.append(complete)
                    fragmented.removeAll(keepingCapacity: true)
                    fragmentOpcode = nil
                }
            } else if !parsed.final {
                guard frame.opcode == .text, fragmentOpcode == nil else { throw WebSocketFrameError.protocolViolation }
                fragmented = frame.payload
                fragmentOpcode = frame.opcode
            } else {
                try validateText(frame)
                frames.append(frame)
            }
        }
        return frames
    }

    private mutating func parseFrame() throws -> (frame: WebSocketFrame, consumed: Int, final: Bool)? {
        guard buffer.count >= 2 else { return nil }
        let first = byte(at: 0), second = byte(at: 1)
        guard first & 0x70 == 0, let opcode = WebSocketOpcode(rawValue: first & 0x0F) else {
            throw WebSocketFrameError.protocolViolation
        }
        let final = first & 0x80 != 0
        let masked = second & 0x80 != 0
        guard masked == expectsMasked else {
            throw expectsMasked ? WebSocketFrameError.unmaskedClientFrame : WebSocketFrameError.maskedServerFrame
        }

        var index = 2
        var length = UInt64(second & 0x7F)
        if length == 126 {
            guard buffer.count >= index + 2 else { return nil }
            length = UInt64(readUInt16(at: index)); index += 2
            guard length >= 126 else { throw WebSocketFrameError.protocolViolation }
        } else if length == 127 {
            guard buffer.count >= index + 8 else { return nil }
            length = readUInt64(at: index); index += 8
            guard length >= 65_536, length & (1 << 63) == 0 else { throw WebSocketFrameError.protocolViolation }
        }
        let isControl = opcode.rawValue >= 0x8
        guard !isControl || (final && length <= 125) else { throw WebSocketFrameError.protocolViolation }
        guard isControl || length <= UInt64(maximumMessageBytes) else { throw WebSocketFrameError.messageTooLarge }
        if masked { index += 4 }
        guard length <= UInt64(Int.max), buffer.count >= index + Int(length) else { return nil }

        var payload = Data(buffer[index..<(index + Int(length))])
        if masked {
            let keyStart = index - 4
            for offset in payload.indices { payload[offset] ^= buffer[buffer.index(buffer.startIndex, offsetBy: keyStart + offset % 4)] }
        }
        return (WebSocketFrame(opcode: opcode, payload: payload), index + Int(length), final)
    }

    private func validateText(_ frame: WebSocketFrame) throws {
        if frame.opcode == .text {
            guard frame.payload.count <= maximumMessageBytes else { throw WebSocketFrameError.messageTooLarge }
            guard frame.text != nil else { throw WebSocketFrameError.invalidUTF8 }
        }
    }

    private func readUInt16(at index: Int) -> UInt16 {
        UInt16(byte(at: index)) << 8 | UInt16(byte(at: index + 1))
    }

    private func readUInt64(at index: Int) -> UInt64 {
        (0..<8).reduce(0) { ($0 << 8) | UInt64(byte(at: index + $1)) }
    }

    private func byte(at offset: Int) -> UInt8 {
        buffer[buffer.index(buffer.startIndex, offsetBy: offset)]
    }
}
