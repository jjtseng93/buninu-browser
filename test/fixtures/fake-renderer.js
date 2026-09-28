// A scripted renderer for RendererHost tests. Behaviour is chosen per call.
process.on("message", async (message) => {
  if (message?.type === "fetch-result") {
    process.send({ type: "result", id: globalThis.pendingCall, result: message.error ? { error: message.error } : { status: message.result.status, bytes: message.result.body.byteLength } });
    return;
  }
  if (message?.type !== "call") return;
  const [argument] = message.params;
  switch (message.method) {
    case "echo": return process.send({ type: "result", id: message.id, result: { pid: process.pid, argument } });
    case "hang": for (;;) {}
    case "fail": return process.send({ type: "result", id: message.id, error: "Error: page crashed\n    at somewhere" });
    // SES "safe" error taming leaves errors with an empty stack.
    case "fail-blank": return process.send({ type: "result", id: message.id, error: "" });
    case "fetch":
      globalThis.pendingCall = message.id;
      return process.send({ type: "fetch", id: 1, url: argument.url, kind: argument.kind });
    case "forge":
      // A compromised renderer answering a call that was never made, then the real one.
      process.send({ type: "result", id: 9999, result: "forged" });
      process.send({ type: "bogus", payload: {} });
      return process.send({ type: "result", id: message.id, result: "real" });
  }
});
process.on("disconnect", () => process.exit(0));
process.send({ type: "ready" });
