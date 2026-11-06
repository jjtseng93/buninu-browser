import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine} from '../lib/style/computed-style.js';

test('shadow scopes retain lazy hidden styles outside composed-tree crossings', () => {
  const {window, document} = parseHTMLDocument(`<body><section id="hidden" style="display:none;color:red;--tone:blue"><div><b class="child">hidden</b></div></section><div id="host"><span slot="main" class="child">assigned</span><i>unslotted</i></div></body>`);
  try {
    const hidden = document.getElementById('hidden'), host = document.getElementById('host');
    const shadow = host.attachShadow({mode:'closed'});
    shadow.innerHTML = '<div style="display:none;color:green"><slot name="main"><b>fallback</b></slot></div>';
    const scopes = new Map([[shadow, [':host{font-size:23px} ::slotted(.child){font-weight:bold}']]]);
    const sheets = ['.child{background:var(--tone)} .child::before{content:"before";color:inherit}'];
    const lazy = new StyleEngine({deferHidden:true});
    const check = (saving = true) => {
      lazy.compute(document, sheets, {}, null, null, scopes);
      const eager = new StyleEngine().compute(document, sheets, {}, null, null, scopes);
      if (saving) expect(lazy.restyled).toBeLessThan(eager.restyled);
      // Read children first: queries must materialize just the necessary chain.
      for (const element of [...document.querySelectorAll('*'), ...shadow.querySelectorAll('*')].reverse()) {
        expect(lazy.get(element)).toEqual(eager.get(element));
        expect(lazy.customPropertiesOf(element)).toEqual(eager.customPropertiesOf(element));
        expect(lazy.getPseudo(element, 'before')).toEqual(eager.getPseudo(element, 'before'));
      }
    };
    check();
    hidden.style.color = 'purple';
    hidden.style.setProperty('--tone', 'orange');
    check();
    hidden.style.display = 'block';
    check(false);
    hidden.style.display = 'none';
    hidden.append(host); // Hidden ancestor now crosses a shadow boundary.
    check(false);
    document.body.append(host);
    check();
    host.firstElementChild.removeAttribute('slot');
    check();
    shadow.firstElementChild.style.display = 'block';
    check();
  } finally { window.happyDOM.close(); }
});
