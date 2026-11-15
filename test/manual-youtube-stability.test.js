import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseArguments,treeFingerprint,fileFingerprint,environmentFingerprint,sameFingerprint} from './manual-youtube-stability-support.js';

test('manual playback options keep browser controls separate from the Casty checkout', () => {
  const options = parseArguments(['--browser-root','/control','--out','/results','--file','--network-label','mobile'],'/harness');
  expect(options).toMatchObject({browserRoot:'/control',castyRoot:'/casty',out:'/results',file:true,networkLabel:'mobile'});
  expect(parseArguments([],'/harness').networkLabel).toBe('unspecified');
  expect(() => parseArguments(['--out'],'/harness')).toThrow('Missing value');
  expect(() => parseArguments(['/one','--out','/two'],'/harness')).toThrow('Duplicate');
  expect(() => parseArguments(['--browser-root','/one','--browser-root','/two'],'/harness')).toThrow('Duplicate');
  expect(() => parseArguments(['--network-label','mobile','--network-label','wifi'],'/harness')).toThrow('Duplicate');
  expect(() => parseArguments(['--seek','60'],'/harness')).toThrow('Unknown');
});

test('cohort environment digest observes effective settings without printing secrets or per-round wrapper paths', () => {
  const environment = {PATH:'/runtime',HTTPS_PROXY:'https://user:secret@example.invalid',BUNINU_RENDER_MIN_INTERVAL:'16',CASTY_BROWSER:'/round-1/browser.mjs'};
  const first = environmentFingerprint(environment);
  expect(first).toMatch(/^[a-f0-9]{64}$/);
  expect(first).not.toContain('secret');
  expect(environmentFingerprint({...environment,CASTY_BROWSER:'/round-2/browser.mjs'})).toBe(first);
  expect(environmentFingerprint({...environment,BUNINU_RENDER_MIN_INTERVAL:'33'})).not.toBe(first);
  expect(environmentFingerprint({...environment,PATH:'/other-runtime'})).not.toBe(first);
  expect(environmentFingerprint(Object.fromEntries(Object.entries(environment).reverse()))).toBe(first);
});

test('runtime fingerprints detect CSS, font, dependency and file-set changes; test peer is hashed separately', async () => {
  const root = mkdtempSync(join(tmpdir(),'youtube-manifest-'));
  try {
    for (const dir of ['lib','usr/share/fonts','node_modules/dependency','test','.git']) mkdirSync(join(root,dir),{recursive:true});
    writeFileSync(join(root,'lib/style.css'),'body{color:red}');
    writeFileSync(join(root,'usr/share/fonts/font.ttf'),new Uint8Array([0,1,2]));
    writeFileSync(join(root,'node_modules/dependency/index.js'),'export const value=1;');
    writeFileSync(join(root,'test/peer.js'),'peer1');
    const baseline = await treeFingerprint(root), peer = await fileFingerprint(join(root,'test/peer.js'));
    writeFileSync(join(root,'.git/HEAD'),'another commit');
    writeFileSync(join(root,'test/peer.js'),'peer2');
    expect(sameFingerprint(baseline,await treeFingerprint(root))).toBe(true);
    expect(sameFingerprint(peer,await fileFingerprint(join(root,'test/peer.js')))).toBe(false);
    for (const [name,value] of [['lib/style.css','body{color:blue}'],['usr/share/fonts/font.ttf','new font'],['node_modules/dependency/index.js','export const value=2;'],['lib/new.png','image bytes']]) {
      const before = await treeFingerprint(root);
      writeFileSync(join(root,name),value);
      expect(sameFingerprint(before,await treeFingerprint(root))).toBe(false);
    }
    expect(await fileFingerprint(join(root,'missing-config.json'))).toEqual({missing:true});
  } finally {rmSync(root,{recursive:true,force:true});}
});
