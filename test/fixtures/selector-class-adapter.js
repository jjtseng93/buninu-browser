import {strict as assert} from 'node:assert';
import SelectorItem from '../../vendor/happy-dom/packages/happy-dom/src/query-selector/SelectorItem.ts';

const reference=SelectorItem.prototype.matchClass;
const {parseHTMLDocument}=await import('../../lib/happy-dom/parser.js');
const {compileSelector,matchesCompiled}=await import('../../lib/happy-dom/selector-matcher.js');
const fast=SelectorItem.prototype.matchClass;
assert.notEqual(fast,reference,'the oracle was captured before installing the adapter');
const {window,document}=parseHTMLDocument('<!doctype html><main><div id="subject"></div><svg xmlns="http://www.w3.org/2000/svg"><g id="foreign"/></svg></main>');
const subject=document.getElementById('subject'),foreign=document.getElementById('foreign');
const names=[null,[],['a'],['A'],['a','b'],['b','a'],['a','a'],['missing'],['a:b'],['123'],['café'],['東京'],
  ['\0'],['a\0b'],['a b'],['\u00a0'],['a\u00a0b'],['a\vb']];
function check(element,label){
  for(const classNames of names){
    const item={classNames};
    assert.deepEqual(fast.call(item,element),reference.call(item,element),`${label}: ${JSON.stringify(classNames)}`);
    assert.deepEqual(fast.call(item,element),reference.call(item,element),`${label}: warm ${JSON.stringify(classNames)}`);
  }
}
const tokens=['','a',' a  b a ','\ta\nb\fa\rb ','A a','a:b 123 café 東京','a\0b \0',
  '\u00a0a\u00a0','a\u00a0b','a\vb','\uFEFFa\uFEFF','\n\t\r\f ','  a\u2028b  '];
try{
  check(document.documentElement,'HTML element without a class attribute');
  check(document.body,'BODY without a class attribute');
  for(const node of [subject,foreign])for(const value of tokens){
    node.setAttribute('class',value);check(node,`${node.tagName} setAttribute ${JSON.stringify(value)}`);
  }
  subject.className='a b';check(subject,'className');
  subject.classList.remove('a');check(subject,'classList.remove');
  subject.classList.add('a');check(subject,'classList.add');
  subject.classList.toggle('b');check(subject,'classList.toggle');
  subject.classList.replace('a','b');check(subject,'classList.replace');
  subject.classList.value='a a b';check(subject,'classList.value');
  subject.getAttributeNode('class').value='b';check(subject,'Attr.value');
  subject.getAttributeNode('class').nodeValue='a';check(subject,'Attr.nodeValue');
  const attr=document.createAttribute('class');attr.value='a b';subject.attributes.setNamedItem(attr);check(subject,'NamedNodeMap.setNamedItem');
  subject.attributes.removeNamedItem('class');check(subject,'NamedNodeMap.removeNamedItem');
  subject.setAttributeNS(null,'class','a');check(subject,'setAttributeNS');
  subject.removeAttributeNS(null,'class');check(subject,'removeAttributeNS');
  subject.setAttribute('class','b');check(subject,'replaced removed attribute');
  subject.remove();subject.className='a b';check(subject,'detached mutation');
  document.querySelector('main').append(subject);check(subject,'reinsertion');
  const cloned=subject.cloneNode(true);cloned.className='A';check(cloned,'cloned node has an independent cache');
  check(subject,'cloning does not change the source cache');

  const xml=document.implementation.createDocument('urn:test','Root');
  const xmlChild=xml.createElementNS('urn:test','Item');xml.documentElement.appendChild(xmlChild);
  xmlChild.setAttribute('Class','a');check(xmlChild,'XML uppercase attribute is not class');
  xmlChild.setAttribute('class','a b');check(xmlChild,'XML lowercase class');
  xmlChild.setAttributeNS('urn:other','x:class','A');check(xmlChild,'namespaced class must not replace no-namespace class');
  xmlChild.removeAttribute('class');check(xmlChild,'XML class removal');
  xml.adoptNode(subject);xml.documentElement.appendChild(subject);check(subject,'adoption preserves raw class validation');
  subject.className='a:b 123 café 東京 a b';check(subject,'mutated after adoption');

  // Escaped and compound selectors must keep their original priority and
  // matching behavior. Compare the same parsed items under both matchers.
  for(const selector of ['.a','.a.b','.a.a','.A','.a\\:b','.\\31 23','.caf\\e9','.東京','.missing',
    '.a\u00a0b','.a\\ b']){
    const compiled=compileSelector(subject,selector);
    assert.ok(compiled,`selector parsed: ${selector}`);
    for(const group of compiled)for(const item of group)
      assert.deepEqual(fast.call(item,subject),reference.call(item,subject),`parsed specificity: ${selector}`);
    let expected;
    SelectorItem.prototype.matchClass=reference;
    try{expected=matchesCompiled(subject,compiled);}finally{SelectorItem.prototype.matchClass=fast;}
    assert.equal(matchesCompiled(subject,compiled),expected,`compiled selector: ${selector}`);
  }
  assert.equal(fast.call({classNames:['a','a']},subject).priorityWeight,20,'duplicate selector classes keep specificity');

  // Public DOMTokenList and ordinary queries remain live; the adapter never
  // replaces their methods or hands out the cached membership array.
  const list=subject.classList;
  assert.equal(list,subject.classList);
  subject.className='a b';assert.equal(list.contains('a'),true);
  subject.className='b';assert.equal(list.contains('a'),false);check(subject,'live public token list');
  assert.equal(xml.querySelector('.b'),subject);
  subject.className='A';assert.equal(xml.querySelector('.b'),null);assert.equal(xml.querySelector('.A'),subject);
}finally{
  SelectorItem.prototype.matchClass=fast;
  window.happyDOM.close();
}
