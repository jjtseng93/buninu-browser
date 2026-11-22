import {test,expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine} from '../lib/style/computed-style.js';

test('incremental sheet reorder and duplicates agree with a fresh cascade',()=>{
 const {document,window}=parseHTMLDocument('<div id="box">Text</div>');
 try{
  const a='#box{color:red}',b='#box{color:blue}',c='#box{width:21px}',engine=new StyleEngine(),node=document.getElementById('box');
  for(const sheets of [[a,b],[b,a],[b,a,b],[a,b],[a,c,b],[b,c,a],[a,b,a],[b,a],[a,a,b]]){
   engine.compute(document,sheets,{},new Set(),new Set());
   const fresh=new StyleEngine().compute(document,[...sheets]);
   expect(engine.get(node)).toEqual(fresh.get(node));
  }
 }finally{window.happyDOM.abort();}
});

test('appending sheets preserves ordinary and pseudo rules across shared selector buckets', () => {
  const {document, window} = parseHTMLDocument('<div class="box" id="item">text</div>');
  try {
    const node = document.getElementById('item');
    const engine = new StyleEngine();
    const sheets = [];
    for (const sheet of [
      '.box {color:red} * {margin:1px} .box::before {content:"before"; color:red}',
      '.box {color:blue} * {margin:2px} .box::after {content:"after"}',
      ':is(.box,#item) {width:35px} .box::before {color:green}',
    ]) {
      sheets.push(sheet);
      engine.compute(document, sheets, {}, new Set(), new Set());
      const fresh = new StyleEngine().compute(document, [...sheets]);
      expect(engine.get(node)).toEqual(fresh.get(node));
      for (const pseudo of ['before', 'after']) {
        expect(engine.getPseudo(node, pseudo)).toEqual(fresh.getPseudo(node, pseudo));
      }
    }
  } finally {
    window.happyDOM.abort();
  }
});
