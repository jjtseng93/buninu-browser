// Shared trusted-click synthesis for Chrome DevTools Protocol.
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// CASTY_DEBUG_CLICK=1 logs each click to ~/.casty/click.log
const DEBUG_CLICK = !!process.env.CASTY_DEBUG_CLICK;
const DEBUG_LOG = join(homedir(), '.casty', 'click.log');

const DESCRIBE = `const d = el => !el ? null : el.tagName.toLowerCase()
  + (el.id ? '#' + el.id : '')
  + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '')
  + ' "' + (el.innerText || el.value || '').trim().slice(0, 30).replace(/\\s+/g, ' ') + '"';`;

// Input coordinates are in the visual viewport; the page's are layout
// coordinates, which differ when the page is zoomed.
const TO_LAYOUT = `const toLayout = (x, y) => {
    const v = window.visualViewport, s = v?.scale || 1;
    return [x / s + (v?.offsetLeft || 0), y / s + (v?.offsetTop || 0)];
  };`;

async function debugBefore(client, x, y) {
  const expression = `(() => { ${DESCRIBE}
    window.__castyClickLog = null;
    document.addEventListener('click', e => {
      window.__castyClickLog = { target: d(e.target), clientX: e.clientX, clientY: e.clientY };
    }, { capture: true, once: true });
    ${TO_LAYOUT}
    return { atPoint: d(document.elementFromPoint(...toLayout(${x}, ${y}))), vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio, sx: scrollX, sy: scrollY };
  })()`;
  const { result } = await client.send('Runtime.evaluate', { expression, returnByValue: true });
  return result?.value;
}

async function debugAfter(client) {
  const { result } = await client.send('Runtime.evaluate', {
    expression: 'window.__castyClickLog', returnByValue: true,
  });
  return result?.value ?? null;
}

export async function showClickMarker(client, x, y, duration = 800) {
  const expression = `(async () => {
    ${TO_LAYOUT}
    const [left, top] = toLayout(${x}, ${y});
    const old = document.getElementById('__casty_click_marker');
    if (old) old.remove();
    const marker = document.createElement('div');
    marker.id = '__casty_click_marker';
    marker.style.cssText = [
      'position:fixed',
      'left:' + left + 'px',
      'top:' + top + 'px',
      'width:14px',
      'height:14px',
      'margin-left:-7px',
      'margin-top:-7px',
      'box-sizing:border-box',
      'border:2px solid white',
      'border-radius:50%',
      'background:#f00',
      'box-shadow:0 0 0 2px rgba(255,0,0,.45)',
      'pointer-events:none',
      'z-index:2147483647',
    ].join(';');
    document.documentElement.appendChild(marker);
    setTimeout(() => marker.remove(), ${duration});
    await new Promise(resolve => requestAnimationFrame(resolve));
  })()`;
  await client.send('Runtime.evaluate', { expression, awaitPromise: true });
}

export async function dispatchClick(client, x, y, { clickCount = 1, button = 'left', source = '?' } = {}) {
  const before = DEBUG_CLICK ? await debugBefore(client, x, y).catch(e => ({ error: e.message })) : null;
  // The marker is cosmetic. CDP engines without a page DOM (e.g. a Wayland
  // compositor) can reject this evaluation but still support real input.
  try { await showClickMarker(client, x, y); } catch {}
  // Input coordinates are CSS pixels (see startBrowser for why they stay so)
  const common = { x, y, button, clickCount };
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', ...common, buttons: button === 'right' ? 2 : 1,
  });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', ...common, buttons: 0,
  });
  if (DEBUG_CLICK) {
    const after = await debugAfter(client).catch(e => ({ error: e.message }));
    const line = JSON.stringify({
      t: new Date().toISOString(), source, button, css: [x, y], clickCount, before, clicked: after,
    });
    try {
      mkdirSync(join(homedir(), '.casty'), { recursive: true });
      appendFileSync(DEBUG_LOG, line + '\n');
    } catch {}
  }
}
