import Foundation
import Testing
@testable import WMWebSocket

struct HandshakeTests {
    @Test func computesRFCExampleAcceptValue() {
        #expect(WebSocketHandshake.acceptValue(for: "dGhlIHNhbXBsZSBub25jZQ==") == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
    }

    @Test func acceptsNonBrowserAndExactAllowedOrigin() throws {
        let noOrigin = request()
        #expect(try WebSocketHandshake(request: noOrigin).headers["origin"] == nil)
        let withOrigin = request(extra: "Origin: https://console.example\r\n")
        #expect(try WebSocketHandshake(request: withOrigin, allowedOrigins: ["https://console.example"]).headers["origin"] == "https://console.example")
    }

    @Test func deniesBrowserOriginByDefaultAndRejectsWrongPath() {
        #expect(throws: WebSocketHandshakeError.originDenied) { try WebSocketHandshake(request: request(extra: "Origin: null\r\n")) }
        #expect(throws: WebSocketHandshakeError.invalidPath) { try WebSocketHandshake(request: request(path: "/other")) }
    }

    private func request(path: String = "/v1", extra: String = "") -> Data {
        Data("GET \(path) HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\(extra)\r\n".utf8)
    }
}
