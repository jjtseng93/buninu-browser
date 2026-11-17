import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { encodePacket, PacketReader } from "../lib/renderer/compositor-channel.js";

const entry = fileURLToPath(new URL("../lib/renderer/main.js", import.meta.url));

for (const [name, stage] of [
  ["renderer exits when the compositor channel closes during its handshake", "handshake"],
  ["renderer exits when the compositor channel closes after ready", "ready"],
  ["renderer exits cleanly on controller disconnect with a live compositor", "disconnect"],
]) {
  test(name, async () => {
    const token = crypto.randomUUID();
    let peer, accepted = false, ready = false;
    const server = createServer(socket => {
      peer = socket;
      const reader = new PacketReader(message => {
        if (accepted) return;
        if (message.type !== "hello" || message.token !== token) return socket.destroy();
        accepted = true;
        const acknowledgement = encodePacket({ type: "accepted" });
        // A FIN after a valid handshake exits the real compositor worker
        // without a Worker error event, even if its codecs are still loading.
        if (stage === "handshake") socket.end(acknowledgement);
        else socket.write(acknowledgement);
      });
      socket.on("data", chunk => reader.push(chunk));
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const endpoint = { port: server.address().port, token };
    const child = Bun.spawn([process.execPath, entry, "--compositor", "--compositor-endpoint=" + JSON.stringify(endpoint)], {
      stdout: "ignore", stderr: "pipe", serialization: "advanced",
      ipc(message) {
        if (message.type === "ready") {
          ready = true;
          if (stage === "ready") peer.end();
          if (stage === "disconnect") child.disconnect();
        }
      },
    });
    const stderr = new Response(child.stderr).text();
    // Bound only this test so a regression releases its child and listener.
    const guard = setTimeout(() => child.kill(), 15000);
    try {
      expect(await child.exited).toBe(stage === "disconnect" ? 0 : 1);
      if (stage !== "disconnect") expect(await stderr).toContain("compositor worker failed: worker closed");
      expect(accepted).toBe(true);
      if (stage !== "handshake") expect(ready).toBe(true);
    } finally {
      clearTimeout(guard);
      peer?.destroy();
      server.close();
    }
  }, 20000);
}
