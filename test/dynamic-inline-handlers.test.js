import {test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';

test('dynamic inline handlers compile for dispatch and reflect updates without replacing property handlers',async()=>{
 const host=new RendererHost();
 try {
  await host.call('loadDocument',{url:'https://example.test/',contentType:'text/html',source:'<body><script>window.hits=[]</script></body>'});
  await host.call('whenLoaded');
  expect(await host.call('evaluate',`(()=>{
    document.body.innerHTML='<div onclick="hits.push(2)"><button onclick="hits.push(1)">go</button></div>';
    const button=document.querySelector('button');
    button.dispatchEvent(new MouseEvent('click',{bubbles:true}));
    button.onclick=()=>hits.push(3);
    button.dispatchEvent(new MouseEvent('click'));
    button.setAttribute('onclick','hits.push(4)');
    button.dispatchEvent(new MouseEvent('click'));
    button.removeAttribute('onclick');
    button.dispatchEvent(new MouseEvent('click'));
    button.setAttribute('onclick','hits.push(5)');
    const reflected=typeof button.onclick;
    button.dispatchEvent(new MouseEvent('click'));
    return [hits,reflected];
  })()`)).toEqual([[1,2,3,4,5],'function']);
 } finally {host.close();}
},20000);
