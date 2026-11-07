import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Run mocks in children: the real renderer and other tests must keep their OS APIs.
for (const mode of ['missing', 'empty', 'present']) {
  test(`optional home-dependent features tolerate ${mode} home metadata`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'browser-home-'));
    const root = new URL('../', import.meta.url).href;
    const source = `
      import {mock} from 'bun:test';
      import * as os from 'node:os';
      import assert from 'node:assert/strict';
      import {mkdirSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';
      import {join} from 'node:path';
      const mode=${JSON.stringify(mode)},root=${JSON.stringify(root)};
      const present=mode==='present', cwd=process.cwd();
      mock.module('node:os',()=>({...os,homedir(){
        if(mode==='missing')throw Object.assign(new Error('uv_os_homedir'),{code:'ENOENT'});
        return present ? cwd : '';
      }}));
      mkdirSync('.casty');
      writeFileSync('.casty/config.json',JSON.stringify({homeUrl:'https://configured.example/'}));
      writeFileSync('.casty/history.json',JSON.stringify({url:['https://old.example/']}));
      const before=readFileSync('.casty/history.json','utf8');
      const {homeDirectory}=await import(root+'lib/home-directory.js');
      assert.equal(homeDirectory(),present ? cwd : null);
      const {FilePicker}=await import(root+'lib/file-picker.js');
      const picker=new FilePicker({});
      assert.equal(picker.directory,cwd);
      await picker.browse('.'); assert.equal(picker.error,'');
      for(const file of ['lib/download-directory.js','frontends/wayland/casty/download-directory.js']) {
        const {downloadsDirectory}=await import(root+file);
        assert.equal(downloadsDirectory({platform:'linux'}),present ? join(cwd,'Downloads') : cwd);
        assert.equal(downloadsDirectory({platform:'win32',home:null,queryWindows:()=>null}),cwd);
        assert.equal(downloadsDirectory({platform:'win32',home:null,queryWindows:()=> 'D:/Downloads'}),'D:/Downloads');
      }
      const {loadConfig,castyPath}=await import(root+'frontends/wayland/casty/config.js');
      assert.equal(castyPath('config.json'),present ? join(cwd,'.casty/config.json') : null);
      assert.equal(loadConfig().homeUrl,present ? 'https://configured.example/' : 'https://github.com/jjtseng93/casty');
      const {loadKeyBindings}=await import(root+'frontends/wayland/casty/keys.js');
      assert.equal(loadKeyBindings()['ctrl+q'],'quit');
      const {loadBookmarks}=await import(root+'frontends/wayland/casty/bookmarks.js');
      assert.deepEqual(loadBookmarks(),[]);
      const {PromptHistory,HISTORY_PATH}=await import(root+'frontends/wayland/casty/urlbar.js');
      const history=new PromptHistory();
      assert.equal(HISTORY_PATH,present ? join(cwd,'.casty/history.json') : null);
      history.add('url','https://new.example/');
      assert.equal(history.list('url').at(-1),'https://new.example/');
      assert.equal(readFileSync('.casty/history.json','utf8')===before,!present);
      await import(root+'frontends/wayland/casty/click.js');
      assert.deepEqual(readdirSync('.casty').sort(),['config.json','history.json']);
    `;
    try {
      const child = Bun.spawn([process.execPath, '-e', source], {
        cwd: dir, env: { ...process.env, CASTY_DEBUG_CLICK: '1' }, stdout: 'pipe', stderr: 'pipe',
      });
      const [stdout,stderr,status] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(status, stdout + stderr).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
