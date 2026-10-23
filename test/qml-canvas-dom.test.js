import { test, expect } from 'bun:test';

for (const mode of ['local', 'html', 'remote']) test(`DOM canvas snapshots: ${mode}`, async () => {
  const child = Bun.spawn([process.execPath, new URL('./fixtures/qml-canvas-dom.js', import.meta.url).pathname, mode],
    { stdout: 'pipe', stderr: 'pipe' });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ exit, stdout, stderr }).toEqual({ exit: 0, stdout: '', stderr: '' });
}, 30000);

// Native ownership must be released on both painting and argument failures.
import { captureQmlDomImage, drawQmlDomImage } from '../lib/qml/canvas-dom.js';
test('DOM snapshot surfaces and images are released on success and exceptions', () => {
  const document = {};
  const element = { nodeType: 1, ownerDocument: document, isConnected: true, contains: target => target === element };
  const root = { id: 1, domNode: element, children: [], style: {} };
  let disposed = 0, deleted = 0, drawn = 0;
  const options = {
    document, tree: { root, nodesById: new Map([[1, root]]) },
    layout: { boxes: [{ nodeId: 1, x: 0, y: 0, width: 10, height: 10, style: {} }], fragments: [], width: 10, height: 10 },
    resources: new Map(), isOriginClean: () => true, paint: () => {},
    kit: { TRANSPARENT: 0, MakeSurface: () => ({ getCanvas: () => ({ clear() {} }), flush() {},
      makeImageSnapshot: () => ({ delete() { deleted++; } }), dispose() { disposed++; } }) },
  };
  const first = captureQmlDomImage(element, options);
  expect(disposed).toBe(1);expect(deleted).toBe(0);
  expect(drawQmlDomImage(first, {}, { drawImage() { drawn++; } }, [element, 0, 0])).toBe(true);
  expect(drawn).toBe(1);expect(deleted).toBe(1);
  expect(drawQmlDomImage(first, {}, {}, [])).toBe(false);
  const second = captureQmlDomImage(element, options);
  expect(() => drawQmlDomImage(second, {}, { drawImage() { throw Error('invalid arguments'); } }, [])).toThrow('invalid arguments');
  expect(deleted).toBe(2);
  const third = captureQmlDomImage(element, options);
  expect(() => drawQmlDomImage(third, element, {}, [])).toThrow('contains the destination');
  expect(deleted).toBe(3);
  expect(() => captureQmlDomImage(element, { ...options, paint() { throw Error('paint failed'); } })).toThrow('paint failed');
  expect(disposed).toBe(4);expect(deleted).toBe(3);
});
