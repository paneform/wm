import Foundation
import Testing
@testable import WMWebSocket

struct FrameTests {
    @Test func decodesMaskedTextIncrementally() throws {
        let encoded = WebSocketFrame(text: "hello").encoded(masked: true, maskingKey: 0x01020304)
        var decoder = WebSocketFrameDecoder(expectsMasked: true)
        #expect(try decoder.append(encoded.prefix(3)).isEmpty)
        #expect(try decoder.append(encoded.dropFirst(3)) == [WebSocketFrame(text: "hello")])
    }

    @Test func handlesExtendedLengthsAndControlFrames() throws {
        let text = String(repeating: "x", count: 200)
        let data = WebSocketFrame(text: text).encoded(masked: false)
        var decoder = WebSocketFrameDecoder(expectsMasked: false)
        #expect(try decoder.append(data).first?.text == text)

        let ping = WebSocketFrame(opcode: .ping, payload: Data([1, 2])).encoded(masked: true, maskingKey: 7)
        var serverDecoder = WebSocketFrameDecoder(expectsMasked: true)
        #expect(try serverDecoder.append(ping).first?.opcode == .ping)
    }

    @Test func enforcesMaskingAndInboundLimit() {
        var maskedDecoder = WebSocketFrameDecoder(expectsMasked: true)
        #expect(throws: WebSocketFrameError.unmaskedClientFrame) {
            try maskedDecoder.append(WebSocketFrame(text: "bad").encoded(masked: false))
        }
        var limited = WebSocketFrameDecoder(expectsMasked: false, maximumMessageBytes: 3)
        #expect(throws: WebSocketFrameError.messageTooLarge) {
            try limited.append(WebSocketFrame(text: "four").encoded(masked: false))
        }
    }

    @Test func rejectsInvalidUTF8() {
        var decoder = WebSocketFrameDecoder(expectsMasked: false)
        let frame = WebSocketFrame(opcode: .text, payload: Data([0xFF])).encoded(masked: false)
        #expect(throws: WebSocketFrameError.invalidUTF8) { try decoder.append(frame) }
    }
}
