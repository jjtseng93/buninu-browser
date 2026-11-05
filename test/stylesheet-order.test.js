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
