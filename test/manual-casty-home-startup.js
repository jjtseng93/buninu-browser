// Native Termux: bun test/manual-casty-home-startup.js [output-directory] [--file] [--code-menu]
// Runs Casty without a URL, using the real HOME/config and a 1280x800 Kitty peer.
// Compare repeated runs with the same config/transport. Inspect ready.png: DOM
// text alone does not prove the branch sentence was laid out and painted.
// --code-menu also saves the first 16 actual Kitty page frames after the click,
// with arrival times in code-frames.json, for inspecting first visible output.
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const peerGeometry = {width:1280, height:800, cellWidth:8, cellHeight:20, cols:160, rows:40};
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// Casty's page occupies image 1, below the address bar and with the final
// column reserved. jsmdcui can transmit a later URL-bar/cursor overlay; that
// image must not replace the page used for screenshots or readiness timing.
export function isCastyContentFrame(bytes, fields) {
  return fields?.i === '1' && Number(fields.c) === peerGeometry.cols - 1
    && Number(fields.r) === peerGeometry.rows - 1 && bytes.length >= 24
    && bytes.subarray(0, 8).equals(pngSignature) && bytes.toString('ascii', 12, 16) === 'IHDR'
    && bytes.readUInt32BE(16) === peerGeometry.width - peerGeometry.cellWidth
    && bytes.readUInt32BE(20) === peerGeometry.height - peerGeometry.cellHeight;
}

// Only the PNG path is negotiated. Default auto transport remains inline, as in
// the original benchmark; --file also accepts the RGB file-readability probe.
// Exported so chunk boundaries can be tested without launching a browser.
export class KittyPeer {
  constructor({ write, frame, file = false, read = readFileSync, remove = unlinkSync }) {
    Object.assign(this, { write, frame, file, read, remove });
    this.tail = '';
    this.inline = null;
  }

  feed(bytes) {
    this.tail += Buffer.from(bytes).toString();
    const sequence = /\x1b_G([\s\S]*?)\x1b\\|\x1b\[14t|\x1b\[16t|\x1b\[\?u/g;
    let match, consumed = 0;
    while ((match = sequence.exec(this.tail))) {
      consumed = sequence.lastIndex;
      if (match[1] !== undefined) this.graphics(match[1]);
      else if (match[0] === '\x1b[14t') this.write(`\x1b[4;${peerGeometry.height};${peerGeometry.width}t`);
      else if (match[0] === '\x1b[16t') this.write(`\x1b[6;${peerGeometry.cellHeight};${peerGeometry.cellWidth}t`);
      else this.write('\x1b[?0u');
    }
    this.tail = this.tail.slice(consumed);
    // Keep an unfinished APC or query, discarding unrelated terminal text.
    const start = this.tail.indexOf('\x1b_G');
    const escape = this.tail.lastIndexOf('\x1b');
    this.tail = start >= 0 ? this.tail.slice(start) : escape >= 0 ? this.tail.slice(escape) : '';
  }

  graphics(packet) {
    const split = packet.indexOf(';');
    const header = split < 0 ? packet : packet.slice(0, split);
    const payload = split < 0 ? '' : packet.slice(split + 1);
    const fields = Object.fromEntries(header.split(',').map(pair => pair.split('=')));
    if (fields.a === 'q') {
      const supported = fields.f === '100' || (this.file && fields.f === '24');
      this.write(`\x1b_Gi=${fields.i};${supported ? 'OK' : 'ENOTSUP'}\x1b\\`);
      return;
    }
    if (fields.a === 'T') {
      this.inline = null;
      if (fields.f !== '100') return;
      if (fields.t === 'f' || fields.t === 't') {
        const path = Buffer.from(payload, 'base64').toString();
        const bytes = this.read(path);
        // Kitty's temporary-file transport transfers unlink ownership.
        if (fields.t === 't') this.remove(path);
        this.frame(bytes, fields.t === 't' ? 'temporary-file' : 'file', fields);
        return;
      }
      if (fields.t && fields.t !== 'd') return;
      this.inline = {chunks:[], fields};
    } else if (fields.a || !this.inline) return;
    this.inline.chunks.push(payload);
    if (fields.m !== '1') {
      this.frame(Buffer.from(this.inline.chunks.join(''), 'base64'), 'inline', this.inline.fields);
      this.inline = null;
    }
  }
}

function connectCdp(url, signal) {
  return new Promise((resolveReady, rejectReady) => {
    const socket = new WebSocket(url), pending = new Map();
    let id = 0, closed = false;
    const timer = setTimeout(() => close(Error('CDP connection timed out')), 60000);
    function close(reason = Error('CDP connection closed')) {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      rejectReady(reason);
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(reason); }
      pending.clear();
      socket.close();
    }
    const aborted = () => close(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    socket.onopen = () => {
      clearTimeout(timer);
      resolveReady({
        close,
        call(method, params = {}) {
          return new Promise((resolve, reject) => {
            if (closed || socket.readyState !== WebSocket.OPEN) return reject(Error('CDP is not connected'));
            const requestId = ++id;
            const timer = setTimeout(() => {
              pending.delete(requestId);
              reject(Error(method + ' observation timed out'));
            }, 60000);
            pending.set(requestId, { resolve, reject, timer });
            try { socket.send(JSON.stringify({ id: requestId, method, params })); }
            catch (error) { clearTimeout(timer); pending.delete(requestId); reject(error); }
          });
        },
      });
    };
    socket.onmessage = event => {
      let message;
      try { message = JSON.parse(event.data); }
      catch (error) { close(error); return; }
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    };
    socket.onerror = () => close(Error('CDP socket error'));
    socket.onclose = () => close();
    if (signal.aborted) aborted();
  });
}

function hasOwnedProcessGroup(pid) {
  // Bun.Terminal creates a new session. Check both IDs before signalling the
  // group, including when its leader has exited but the renderer has not.
  try {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (Number(fields[2]) === pid && Number(fields[3]) === pid) return true;
      } catch { /* The process may exit during this scan. */ }
    }
  } catch { /* Non-Linux hosts still use Casty's normal shutdown. */ }
  return false;
}

async function stopCasty(proc) {
  if (!proc) return;
  try { proc.terminal?.write('\x11'); } catch {}
  await Promise.race([proc.exited, Bun.sleep(2000)]);
  // Normal Ctrl-Q lets Casty stop its browser. A failed benchmark must also
  // stop descendants, rather than leaving CPU-heavy renderers behind.
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (hasOwnedProcessGroup(proc.pid)) {
      try { process.kill(-proc.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (proc.exitCode === null) {
      try { proc.kill(signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (signal === 'SIGTERM') await Bun.sleep(300);
  }
  await Promise.race([proc.exited, Bun.sleep(1000)]);
  try { proc.terminal?.close(); } catch {}
}

async function main() {
  const args = Bun.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: bun test/manual-casty-home-startup.js [empty-output-directory] [--file] [--code-menu]\n\nRun in native Termux, with no other benchmark running. --file enables PNG file transport; default auto transport is inline.\nready.png is a CDP screenshot after branch text exists. kitty-ready.png is the last full page frame (URL-bar/cursor overlays excluded); timing.json records whether it arrived after that text.\n--code-menu also clicks the Code button through CDP and measures time until Download ZIP is visible, saving code-menu.png and kitty-code-menu.png.');
    return;
  }
  const positional = args.filter(arg => !['--file', '--code-menu'].includes(arg));
  if (positional.length > 1 || positional.some(arg => arg.startsWith('--'))) throw Error('Unknown arguments; use --help');
  const root = resolve(import.meta.dir, '..');
  const out = resolve(positional[0] || mkdtempSync(join(tmpdir(), 'casty-home-')));
  mkdirSync(out, { recursive: true });
  if (readdirSync(out).length) throw Error('Output directory must be empty (avoid stale endpoints/results): ' + out);
  const endpointFile = join(out, 'endpoint');
  writeFileSync(join(out, 'browser.mjs'), `
import { writeFileSync } from 'node:fs';
const originalError = console.error;
console.error = (...args) => {
  const text = args.join(' '), prefix = 'DevTools listening on ';
  if (text.startsWith(prefix)) writeFileSync(${JSON.stringify(endpointFile)}, text.slice(prefix.length).trim());
  originalError(...args);
};
const { main } = await import(${JSON.stringify(Bun.pathToFileURL(join(root, 'buninu-browser.js')).href)});
await main();
`);

  let proc, cdp, frames = 0, ignoredImages = 0, lastFrame, lastFrameMs, branchMs, peerError;
  let terminalTail = '', outputTerminal, finishing = false, codeClickMs = null;
  const codeFrames = [];
  const events = [], abort = new AbortController();
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  function mark(name, extra = {}) {
    const event = { name, ms: elapsed(), ...extra };
    events.push(event);
    console.log(JSON.stringify(event));
    writeFileSync(join(out, 'timing.json'), JSON.stringify(events, null, 2));
    return event.ms;
  }
  async function wait(check) {
    for (;;) {
      if (abort.signal.aborted) throw abort.signal.reason;
      if (peerError) throw peerError;
      if (proc?.exitCode !== null && proc?.exitCode !== undefined) {
        writeFileSync(join(out, 'terminal-error.txt'), terminalTail);
        throw Error(`Casty exited early: ${proc.exitCode}\n${terminalTail}`);
      }
      if (await check()) return;
      if (performance.now() - started > 180000) throw Error('Observation limit reached');
      await Bun.sleep(200);
    }
  }
  const onSignal = signal => {
    process.exitCode = signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143;
    abort.abort(Error('Interrupted by ' + signal));
  };
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => onSignal(signal)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);

  try {
    const peer = new KittyPeer({
      file: args.includes('--file'),
      write: bytes => outputTerminal.write(bytes),
      frame(bytes, transport, placement) {
        if (!isCastyContentFrame(bytes, placement)) { ignoredImages++;return; }
        lastFrame = bytes;
        lastFrameMs = elapsed();
        frames++;
        // Keep already-received page frames without extra CDP reads. Flush
        // them after the experiment so file writes do not delay the click.
        if (codeClickMs !== null && codeFrames.length < 16) codeFrames.push({ms:lastFrameMs, bytes});
        if (frames === 1) { mark('first-kitty-frame', { transport }); writeFileSync(join(out, 'first.png'), bytes); }
      },
    });
    proc = Bun.spawn([process.execPath, resolve(root, '../casty/index.js')], {
      env: { ...process.env, CASTY_BROWSER: join(out, 'browser.mjs'), BUNINU_LOG: join(out, 'browser.log'), TERM: 'xterm-256color', TMUX: '' },
      onExit(_child, exitCode) {
        if (!finishing) abort.abort(Error(`Casty exited early: ${exitCode}\n${terminalTail}`));
      },
      terminal: {
        cols: peerGeometry.cols, rows: peerGeometry.rows,
        data(terminal, bytes) {
          outputTerminal = terminal;
          terminalTail = (terminalTail + Buffer.from(bytes).toString()).slice(-8000);
          // Stream errors must reach finally, not escape a native callback.
          try { peer.feed(bytes); } catch (error) { peerError = error; }
        },
      },
    });
    mark('spawn', { pid: proc.pid, out, fileSupport: args.includes('--file') });
    await wait(() => existsSync(endpointFile));
    mark('cdp-listening');
    const endpoint = new URL(readFileSync(endpointFile, 'utf8'));
    let target;
    await wait(async () => {
      const response = await fetch('http://' + endpoint.host + '/json/list', { signal: abort.signal });
      if (!response.ok) throw Error('Target listing failed: HTTP ' + response.status);
      target = (await response.json()).find(target => target.type === 'page');
      return target;
    });
    cdp = await connectCdp(target.webSocketDebuggerUrl, abort.signal);
    // Preserve the original polling cadence and innerText query so before/after
    // measurements include the same (potentially layout-flushing) observer.
    await wait(async () => {
      const result = await cdp.call('Runtime.evaluate', {
        expression: `(()=>{const text=document.body?.innerText||'';const match=text.match(/This branch is[^\\n]{0,250}/);return {url:location.href,title:document.title,match:match?.[0]||'',complete:!!match&&/\\d[\\s\\S]*ahead/.test(match[0])}})()`,
        returnByValue: true,
      });
      if (result.exceptionDetails) throw Error('Branch observation failed: ' + JSON.stringify(result.exceptionDetails));
      const value = result.result?.value;
      if (!value?.complete) return false;
      branchMs = mark('branch-text', value);
      return true;
    });
    const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(out, 'ready.png'), Buffer.from(screenshot.data, 'base64'));
    mark('ready-screenshot', { frames });
    await Bun.sleep(1000);
    if (peerError) throw peerError;
    if (lastFrame) {
      writeFileSync(join(out, 'kitty-ready.png'), lastFrame);
      mark('last-kitty-frame', { frameMs: lastFrameMs, afterBranchText: lastFrameMs >= branchMs });
    }
    if (args.includes('--code-menu')) {
      const location = await cdp.call('Runtime.evaluate', {
        expression: `(()=>{const button=[...document.querySelectorAll('button')].find(el=>el.innerText.trim()==='Code');if(!button)throw Error('Code button missing');const r=button.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,alreadyOpen:document.body.innerText.includes('Download ZIP')}})()`,
        returnByValue: true,
      });
      if (location.exceptionDetails) throw Error(JSON.stringify(location.exceptionDetails));
      const point = location.result?.value;
      if (!point || point.alreadyOpen) throw Error('Code menu is missing or already open');
      const clicked = mark('code-click', { x: point.x, y: point.y });
      codeClickMs = clicked;
      await cdp.call('Input.dispatchMouseEvent', { type:'mousePressed', button:'left', buttons:1, clickCount:1, x:point.x, y:point.y });
      mark('code-pressed', { delayMs: elapsed() - clicked });
      await cdp.call('Input.dispatchMouseEvent', { type:'mouseReleased', button:'left', buttons:0, clickCount:1, x:point.x, y:point.y });
      mark('code-released', { delayMs: elapsed() - clicked });
      await wait(async () => {
        const result = await cdp.call('Runtime.evaluate', {
          expression: `document.body.innerText.includes('Download ZIP')`, returnByValue: true,
        });
        if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
        return result.result?.value === true;
      });
      mark('code-menu-text', { delayMs: elapsed() - clicked });
      const menu = await cdp.call('Page.captureScreenshot', { format:'png' });
      writeFileSync(join(out, 'code-menu.png'), Buffer.from(menu.data, 'base64'));
      const captured = mark('code-menu-screenshot', { delayMs: elapsed() - clicked });
      await Bun.sleep(1000);
      if (lastFrame) {
        writeFileSync(join(out, 'kitty-code-menu.png'), lastFrame);
        mark('code-menu-kitty-frame', { frameMs:lastFrameMs, delayMs:lastFrameMs-clicked, afterScreenshot:lastFrameMs>=captured });
      }
    }
  } catch (error) {
    writeFileSync(join(out, 'terminal-error.txt'), terminalTail);
    mark('error', { message: String(error) });
    throw error;
  } finally {
    finishing = true;
    cdp?.close();
    try { await stopCasty(proc); }
    finally {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      mark('finished', { frames, ignoredImages });
      if (codeFrames.length) {
        const manifest = codeFrames.map(({ms, bytes}, index) => {
          const file = `code-frame-${index + 1}.png`;
          writeFileSync(join(out, file), bytes);
          return {file, ms, delayMs:ms-codeClickMs};
        });
        writeFileSync(join(out, 'code-frames.json'), JSON.stringify(manifest, null, 2));
      }
    }
  }
}

if (import.meta.main) await main();
