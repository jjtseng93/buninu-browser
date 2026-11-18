// A scripted renderer for RendererHost tests. Behaviour is chosen per call.
const audioEvents = [];
let openAudioCall;
process.on("message", async (message) => {
  if (message?.type === "audio-event") {
    if (message.event === "ready") process.send({type:"result", id:openAudioCall, result:true});
    else audioEvents.push([message.event, message.seconds ?? message.bytes]);
    return;
  }
  if (message?.type === "fetch-result") {
    process.send({ type: "result", id: globalThis.pendingCall, result: message.error ? { error: message.error } : { status: message.result.status, bytes: message.result.body.byteLength } });
    return;
  }
  if (message?.type !== "call") return;
  const [argument] = message.params;
  switch (message.method) {
    case "openAudio":
      openAudioCall = message.id;
      return process.send({type:"audio-open", id:1, rate:48000, channels:2});
    case "takeAudio":
      if (argument) process.send({type:"audio-timing-received", id:1});
      return process.send({type:"result", id:message.id, result:audioEvents.splice(0)});
    case "slow":
      await Bun.sleep(200);
      return process.send({ type: "result", id: message.id, result: "completed" });
    case "showFragment":
      await Bun.sleep(200);
      return process.send({ type: "result", id: message.id, result: "positioned" });
    case "loadDocument":
      await Bun.sleep(argument.delay);
      return process.send({ type: "result", id: message.id, result: "loaded" });
    case "configuration": return process.send({ type: "result", id: message.id, result: { args: process.argv, secret: process.env.BUNINU_TEST_PRIVATE_ENV } });
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
const delay = Number(process.argv.find(arg => arg.startsWith('--ready-delay='))?.split('=')[1] ?? 0);
if (process.argv.includes('--exit-before-ready')) process.exit(2);
if (delay) await Bun.sleep(delay);
process.send({ type: "ready" });
