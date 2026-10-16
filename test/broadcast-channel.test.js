import { expect, test } from "bun:test";
import { createBroadcastChannels } from "../lib/renderer/broadcast-channel.js";

const scope = origin => createBroadcastChannels({ origin, EventTarget, DOMException,
  runTask: task => task(),
  realm: { messageEvent: (type, fields) => new MessageEvent(type, fields), markTrusted() {} },
});

test("BroadcastChannel separates origins, channel names and opaque document origins and disposes native channels", async () => {
  const a=scope('https://a.test'), b=scope('https://b.test'), a2=scope('https://a.test'), opaque1=scope('null'), opaque2=scope('null');
  const name=crypto.randomUUID(), sender=new a.BroadcastChannel(name), other=new b.BroadcastChannel(name),
    peer=new a2.BroadcastChannel(name), otherName=new a.BroadcastChannel(name+'other'),
    opaqueSender=new opaque1.BroadcastChannel(name), opaquePeer=new opaque2.BroadcastChannel(name);
  const received=[];
  other.onmessage=()=>received.push('other origin');peer.onmessage=()=>received.push('same origin');
  otherName.onmessage=()=>received.push('other name');opaquePeer.onmessage=()=>received.push('opaque');
  try {
    sender.postMessage('message');opaqueSender.postMessage('opaque message');
    for(let i=0;i<100&&!received.length;i++)await Bun.sleep(2);
    await Bun.sleep(10);
    expect(received).toEqual(['same origin']);
    a.dispose();
    expect(()=>sender.postMessage('closed')).toThrow('The channel is closed');
    expect(()=>new a.BroadcastChannel('closed realm')).toThrow('The document is no longer active');
  } finally {for(const item of [a,b,a2,opaque1,opaque2])item.dispose();}
});
