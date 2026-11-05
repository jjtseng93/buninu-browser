import {expect, test} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {observeFrameDisconnect} from '../lib/happy-dom/frame-lifecycle.js';

for (const [name, remove] of [
  ['remove', (frame) => frame.remove()],
  ['removeChild', (frame) => frame.parentNode.removeChild(frame)],
  ['ancestor removal', (_, holder) => holder.remove()],
  ['replaceChildren', (_, holder) => holder.replaceChildren()],
  ['innerHTML', (_, holder) => { holder.innerHTML = '<p>replacement</p>'; }],
  ['textContent', (_, holder) => { holder.textContent = 'replacement'; }],
]) {
  test(`iframe context disconnects synchronously on ${name}`, () => {
    const {document, window} = parseHTMLDocument('<div><iframe></iframe></div>');
    try {
      const frame = document.querySelector('iframe'), holder = frame.parentNode;
      const events = [];
      observeFrameDisconnect(frame, () => events.push(frame.isConnected));
      remove(frame, holder);
      expect(events).toEqual([false]);
      frame.remove();
      expect(events).toEqual([false]);
    } finally { window.happyDOM.close(); }
  });
}

test('moving or reinserting an iframe destroys the old context exactly once', () => {
  const {document, window} = parseHTMLDocument('<div><iframe></iframe></div><aside></aside>');
  try {
    const frame = document.querySelector('iframe'), events = [];
    const stopOld = observeFrameDisconnect(frame, () => events.push('old'));
    document.querySelector('aside').append(frame);
    expect(events).toEqual(['old']);
    observeFrameDisconnect(frame, () => events.push('new'));
    stopOld();
    frame.remove();
    document.body.append(frame);
    expect(events).toEqual(['old', 'new']);
    frame.remove();
    expect(events).toEqual(['old', 'new']);
  } finally { window.happyDOM.close(); }
});

test('removing a shadow host disconnects its rendered child frame', () => {
  const {document, window} = parseHTMLDocument('<div></div>');
  try {
    const host = document.querySelector('div'), shadow = host.attachShadow({mode:'open'});
    const frame = document.createElement('iframe');
    shadow.append(frame);
    let calls = 0;
    observeFrameDisconnect(frame, () => calls++);
    host.remove();
    expect(calls).toBe(1);
  } finally { window.happyDOM.close(); }
});

test('adoption disconnects the old frame without retaining a registration', () => {
  const first = parseHTMLDocument('<iframe></iframe>'), second = parseHTMLDocument('');
  try {
    const frame = first.document.querySelector('iframe'), events = [];
    observeFrameDisconnect(frame, () => events.push('old'));
    second.document.adoptNode(frame);
    second.document.body.append(frame);
    expect(events).toEqual(['old']);
    observeFrameDisconnect(frame, () => events.push('adopted'));
    frame.remove();
    expect(events).toEqual(['old', 'adopted']);
  } finally { first.window.happyDOM.close(); second.window.happyDOM.close(); }
});

test('unsubscribed and inert frames keep normal DOM removal behavior', () => {
  const {document, window} = parseHTMLDocument('<iframe></iframe><iframe></iframe>');
  try {
    const frames = document.querySelectorAll('iframe');
    let calls = 0;
    const stop = observeFrameDisconnect(frames[0], () => calls++);
    stop(); stop();
    document.body.replaceChildren();
    expect(calls).toBe(0);
    expect([...frames].every(frame => !frame.isConnected)).toBe(true);
  } finally { window.happyDOM.close(); }
});
