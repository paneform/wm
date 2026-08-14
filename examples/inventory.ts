const url = process.argv[2] ?? "ws://127.0.0.1:17832/v1";
const socket = new WebSocket(url);

socket.addEventListener("open", () => {
  socket.send(JSON.stringify({
    type: "subscribe",
    request_id: crypto.randomUUID(),
    subscription_id: "typescript-example",
    topics: ["window.inventory", "display.inventory", "inventory.refreshed"],
    projection: "delta",
    after_sequence: null,
  }));
});

socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(String(data));
  console.log(JSON.stringify(message));
});
