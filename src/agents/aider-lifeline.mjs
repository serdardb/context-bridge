import net from "node:net";
import { randomBytes } from "node:crypto";

// A private loopback connection dies with the entry process, including SIGKILL.
// Unlike inherited fd numbers, this transport is also available on Windows.
export async function openAiderLifeline() {
  const token = randomBytes(32).toString("hex");
  const connections = new Set();
  let claimed = false;
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => connections.delete(socket));
    socket.setTimeout(5000, () => socket.destroy());
    let received = "";
    socket.on("data", (data) => {
      if (claimed) { socket.destroy(); return; }
      received += data.toString("utf8");
      if (received.length > 65) { socket.destroy(); return; }
      if (!received.endsWith("\n")) return;
      if (received !== `${token}\n`) { socket.destroy(); return; }
      claimed = true;
      socket.setTimeout(0);
      socket.write("ready\n");
      for (const other of connections) if (other !== socket) other.destroy();
      server.close();
    });
  });
  server.maxConnections = 8;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    environment: JSON.stringify({ port: server.address().port, token }),
    close() {
      for (const socket of connections) socket.destroy();
      server.close();
    },
  };
}
