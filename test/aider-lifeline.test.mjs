import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { openAiderLifeline } from "../src/agents/aider-lifeline.mjs";

test("Aider parent connection rejects strangers and stays open until its owner closes it", async () => {
  const owner = await openAiderLifeline();
  const { port, token } = JSON.parse(owner.environment);
  const sockets = [];
  const connect = () => {
    const socket = net.connect(port, "127.0.0.1");
    sockets.push(socket);
    socket.setTimeout(3000, () => socket.destroy(new Error("test connection timed out")));
    return socket;
  };
  try {
    const stranger = connect();
    const rejected = once(stranger, "close");
    stranger.write("wrong-token\n");
    await rejected;
    const child = connect();
    const ready = once(child, "data");
    child.write(`${token}\n`);
    assert.equal((await ready)[0].toString(), "ready\n");
    assert.equal(child.destroyed, false);
    const stopped = once(child, "close");
    owner.close();
    await stopped;
  } finally {
    for (const socket of sockets) socket.destroy();
    owner.close();
  }
});
