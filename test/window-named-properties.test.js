import {test, expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {windowNamedProperties} from '../lib/renderer/window-named-properties.js';

test('named access indexes names without rescanning on misses, style writes or text changes', async () => {
  const {document, window} = parseHTMLDocument('<form name="formName"></form><div id="one">text</div><div id="two"></div>');
  try {
    let queries = 0;
    const query = document.querySelectorAll.bind(document);
    document.querySelectorAll = (...args) => { queries++; return query(...args); };
    const named = windowNamedProperties(document, {wrap:x=>x, live:x=>x}, null);
    const one = named.one;
    expect(named.formName.tagName).toBe('FORM');
    const initial = queries;
    for (let i=0;i<100;i++) expect(named['missing'+i]).toBeUndefined();
    one.style.color = 'red';
    one.firstChild.data = 'new';
    one.appendChild(document.createTextNode('more'));
    expect(named.one).toBe(one);
    expect(queries).toBe(initial);
    one.id = 'renamed';
    expect(named.one).toBeUndefined();
    expect(named.renamed).toBe(one);
    const odd = 'x"]\\\u0000';
    one.id = odd;
    expect(named[odd]).toBe(one);
    expect(named['absent"]']).toBeUndefined();
    one.id = 'two';
    const group = named.two;
    expect(group.length).toBe(2);
    expect(group[0]).toBe(one);
    document.body.appendChild(one);
    expect(group[1]).toBe(one);
    one.remove();
    expect(group.length).toBe(1);
    const form = named.formName;
    form.setAttribute('name','later');
    await Promise.resolve(); // also invalidate after normal observer delivery
    expect(named.formName).toBeUndefined();
    expect(named.later).toBe(form);
    document.body.innerHTML = '<span id="final"></span>';
    expect(named.later).toBeUndefined();
    expect(named.final.tagName).toBe('SPAN');
    expect(queries).toBe(initial);
  } finally { await window.happyDOM.close(); }
});

test('named index updates moved and removed subtrees without stale entries', async () => {
  const {document, window} = parseHTMLDocument('<section><div id="first"><form name="deep"></form></div></section><aside></aside>');
  try {
    const named = windowNamedProperties(document, {wrap:x=>x,live:x=>x}, null);
    const form = named.deep, first = named.first;
    const section = document.querySelector('section'), aside = document.querySelector('aside');
    // Drain an attribute change and a subtree move in the same lookup.
    first.id = 'renamed';
    aside.append(first);
    expect(named.first).toBeUndefined();
    expect(named.renamed).toBe(first);
    expect(named.deep).toBe(form);
    aside.remove();
    form.setAttribute('name','moved');
    section.append(form); // a descendant survives removal of its old ancestor
    expect(named.renamed).toBeUndefined();
    expect(named.deep).toBeUndefined();
    expect(named.moved).toBe(form);
    section.remove();
    expect(named.moved).toBeUndefined();
    document.body.append(section);
    expect(named.moved).toBe(form);
  } finally { await window.happyDOM.close(); }
});

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

test('named index preserves frame precedence, eligible names and ordinary tree boundaries', async () => {
  const {document, window} = parseHTMLDocument('<div id="shared"></div><iframe name="shared"></iframe><input name="excluded"><form id="same" name="same"></form><section></section>');
  try {
    const frameWindow = {};
    const named = windowNamedProperties(document, {
      wrap: element => element.tagName === 'IFRAME' ? {contentWindow:frameWindow} : element,
      live: value => value,
    }, null);
    expect(named.shared).toBe(frameWindow);
    expect(named.excluded).toBeUndefined();
    expect(named.same.tagName).toBe('FORM');
    document.querySelector('iframe').remove();
    expect(named.shared.tagName).toBe('DIV');
    const host = document.querySelector('section');
    host.attachShadow({mode:'open'}).innerHTML = '<div id="hiddenName"></div>';
    expect(named.hiddenName).toBeUndefined();
    const template = document.createElement('template');
    template.innerHTML = '<div id="templateName"></div>';
    document.body.append(template);
    expect(named.templateName).toBeUndefined();
    document.body.append(template.content);
    expect(named.templateName.tagName).toBe('DIV');
    host.innerHTML = '<img name="added">';
    expect(named.added.tagName).toBe('IMG');
    host.remove();
    expect(named.added).toBeUndefined();
  } finally { await window.happyDOM.close(); }
});

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
