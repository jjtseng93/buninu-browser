import {test, expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';

test('Window named elements are live, shadowable, and available in classic scripts and inline handlers', async () => {
  const host = new RendererHost();
  try {
    await host.call('loadDocument', {url:'https://example.test/',source:`
      <textarea id="source">hello</textarea><textarea id="result"></textarea>
      <form name="namedForm"></form><input name="notGlobal"><div id="dupe"></div><div id="dupe"></div>
      <button onclick="result.value=source.value.toUpperCase()">Convert</button>
      <script>window.initial = source.value; window.group = dupe;</script>`,contentType:'text/html'});
    expect(await host.call('evaluate', '[initial, namedForm.tagName, typeof notGlobal, dupe.length, dupe.item(0).tagName]')).toEqual(['hello','FORM','undefined',2,'DIV']);
    expect(await host.call('evaluate', 'document.querySelector("button").click(); result.value')).toBe('HELLO');
    expect(await host.call('evaluate', 'source.id="renamed"; [typeof source, renamed.value]')).toEqual(['undefined','hello']);
    expect(await host.call('evaluate', 'window.renamed=42; let x=renamed;delete window.renamed;[x,renamed.value]')).toEqual([42,'hello']);
    expect(await host.call('evaluate', 'document.querySelectorAll("#dupe")[0].remove(); [group.length, dupe.tagName]')).toEqual([1,'DIV']);
    expect(await host.call('evaluate', 'renamed.remove(); typeof renamed')).toBe('undefined');
    expect(await host.call('evaluate', `eval('(async()=>{\\nresult.value="first"\\nresult.value += " second"\\n})()'); result.value`)).toBe('first second');
  } finally {host.close();}
},20000);

test('type selectors accept underscores, including escaped punctuation and selector lists', () => {
  const {document} = parseHTMLDocument('<x_widget></x_widget><g:family_creation></g:family_creation>');
  expect(document.querySelectorAll('x_widget, g\\:family_creation').length).toBe(2);
});

test('deferred absolute backgrounds paint before later relative links, including after relayout', async () => {
  const host = new RendererHost();
  try {
    await host.call('loadDocument',{url:'https://example.test/',contentType:'text/html',source:`
      <style>body{margin:0}.container{position:relative}.background{position:absolute;inset:0;background:red}
      .front{position:relative}a{display:block;height:50px;background:green}</style>
      <div class="container"><div class="background"><div style="height:100%"></div></div><div class="front"><a href="#ok">Click</a></div></div>`});
    for (const width of [800,600,800]) {
      await host.call('resize',width,600,1);
      expect(await host.call('evaluate','document.elementFromPoint(20,20).tagName')).toBe('A');
      expect(await host.call('click',20,20)).toBeTruthy();
    }
  }finally{host.close();}
},20000);
