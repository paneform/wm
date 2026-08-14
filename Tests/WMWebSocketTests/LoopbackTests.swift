import Darwin
import Foundation
import Testing
@testable import WMWebSocket

private actor EchoHandler: WebSocketRequestHandler {
    func connected(clientID: UUID) -> [String] { ["{\"type\":\"session.welcome\"}"] }
    func handle(text: String, clientID: UUID) -> [String] { [text] }
}

struct LoopbackTests {
    @Test func clientAndServerExchangeText() throws {
        let port = try unusedPort()
        let server = WebSocketServer(configuration: .init(port: port), handler: EchoHandler())
        try server.start()
        defer { server.stop() }

        let client = WebSocketClient(url: URL(string: "ws://127.0.0.1:\(port)/v1")!)
        try client.connect()
        defer { client.close() }
        #expect(try client.receive() == "{\"type\":\"session.welcome\"}")
        try client.send(text: "{\"type\":\"request\",\"request_id\":\"req-1\"}")
        #expect(try client.receive() == "{\"type\":\"request\",\"request_id\":\"req-1\"}")
    }

    @Test func portConflictFailsClearly() throws {
        let port = try unusedPort()
        let first = WebSocketServer(configuration: .init(port: port), handler: EchoHandler())
        try first.start()
        defer { first.stop() }
        let second = WebSocketServer(configuration: .init(port: port), handler: EchoHandler())
        #expect(throws: WebSocketTransportError.self) { try second.start() }
    }

    private func unusedPort() throws -> UInt16 {
        let socket = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard socket >= 0 else { throw WebSocketTransportError.socketFailed("test socket") }
        defer { Darwin.close(socket) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        return try withUnsafePointer(to: &address) { pointer in
            try pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
                guard Darwin.bind(socket, socketAddress, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0 else {
                    throw WebSocketTransportError.socketFailed("test bind")
                }
                var bound = sockaddr_in()
                var length = socklen_t(MemoryLayout<sockaddr_in>.size)
                guard withUnsafeMutablePointer(to: &bound, { boundPointer in
                    boundPointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(socket, $0, &length) }
                }) == 0 else { throw WebSocketTransportError.socketFailed("getsockname") }
                return UInt16(bigEndian: bound.sin_port)
            }
        }
    }
}
