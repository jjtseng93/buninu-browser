import {test,expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine,matchSelectors} from '../lib/style/computed-style.js';

test('selector keys follow class, id and attribute changes across repeated passes', async () => {
  const {document,window}=parseHTMLDocument('<section class="left"><div class="a a"><span class="leaf"></span></div></section>');
  try {
    const parent=document.querySelector('section'),node=document.querySelector('div'),leaf=document.querySelector('span');
    const engine=new StyleEngine(),sheets=['.left .a{width:11px}.right .b{width:22px}.a[data-wide]{width:33px}#exact{width:44px}'];
    const width=()=>engine.compute(document,sheets).get(node).width;
    expect(width()).toBe(11);
    expect(width()).toBe(11);
    node.setAttribute('data-wide','');expect(width()).toBe(33);
    node.id='exact';expect(width()).toBe(44);
    node.removeAttribute('id');node.removeAttribute('data-wide');
    parent.className='right';node.className='b';expect(width()).toBe(22);
    node.className='a';expect(width()).toBe('auto');
    parent.className='left';node.className=Array(32).fill('a').join(' ');expect(width()).toBe(11);
    const check=()=>matchSelectors(parent,['.left .a .leaf']).get('.left .a .leaf').has(leaf);
    expect(check()).toBe(true);
    node.removeAttribute('class');expect(check()).toBe(false);expect(width()).toBe('auto');
    node.className=' \ta\n';expect(check()).toBe(true);expect(width()).toBe(11);
  } finally { await window.happyDOM.close(); }
});
