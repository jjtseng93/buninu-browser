import {expect, test} from 'bun:test';
import {secureContextForDocument} from '../lib/renderer/secure-context.js';
const frame = (url, parent = null) => ({url:()=>url, parent:()=>parent});
test('secure contexts distinguish trustworthy schemes and loopback hosts', () => {
  for (const url of ['https://page.test/','file:///tmp/page.html','http://localhost/',
    'http://sub.localhost/','http://localhost./','http://127.0.0.2/','http://127.1/',
    'http://2130706433/','http://[::1]/','blob:https://page.test/id']) {
    expect(secureContextForDocument(url)).toBe(true);
  }
  for (const url of ['http://page.test/','http://localhost.example/','http://128.0.0.1/',
    'http://192.168.1.1/','data:text/html,hello','blob:null/id','about:blank','about:srcdoc','invalid']) {
    expect(secureContextForDocument(url)).toBe(false);
  }
});
test('about:blank inherits its parent but every ancestor must be secure', () => {
  const secure=frame('https://page.test/'),insecure=frame('http://page.test/');
  expect(secureContextForDocument('about:blank',secure)).toBe(true);
  expect(secureContextForDocument('about:srcdoc',secure)).toBe(true);
  expect(secureContextForDocument('about:blank',insecure)).toBe(false);
  expect(secureContextForDocument('https://child.test/',insecure)).toBe(false);
  expect(secureContextForDocument('https://child.test/',frame('about:blank',secure))).toBe(true);
  expect(secureContextForDocument('https://child.test/',frame('https://page.test/',insecure))).toBe(false);
  expect(secureContextForDocument('about:blank',frame('about:blank'))).toBe(false);
  const cyclic=frame('https://page.test/');cyclic.parent=()=>cyclic;
  expect(secureContextForDocument('https://page.test/',cyclic)).toBe(false);
});
