import {test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';
test('sloppy direct eval declares caller-local functions and vars without leaking between calls',async()=>{
 const host=new RendererHost();try{
  await host.call('loadDocument',{url:'https://eval.test/',contentType:'text/html',source:`<script>
  function make(source) {
    let prefix='local:';
    eval(source);
    const first=helper();
    eval('count += 1');
    return [first,helper(),typeof count,()=>helper()];
  }
  window.a=make('var count=2; function helper(){return prefix+count;}');
  window.b=make('var count=7; function helper(){return prefix+count;}');
  window.same=(function(){var existing=1;eval('var existing=3');return existing;})();
  window.strict=(function(){'use strict';eval('var hidden=3');return typeof hidden;})();
  window.lexical=(function(){eval('let hidden=3');return typeof hidden;})();
  </script>`});
  await host.call('whenLoaded');
  expect(await host.call('evaluate',`[a[0],a[1],a[2],a[3](),b[0],b[3](),same,strict,lexical,typeof helper,typeof count]`)).toEqual(['local:2','local:3','number','local:3','local:7','local:8',3,'undefined','undefined','undefined','undefined']);
 }finally{host.close();}
},20000);
