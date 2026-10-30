import {test,expect} from 'bun:test';
import {createBrowser} from '../lib/headless-shell.js';
import {CdpServer} from '../lib/cdp-server.js';
import {CDP} from '../tools/browser-lab.js';
const until=async fn=>{for(let i=0;i<500;i++){if(fn())return;await Bun.sleep(10);}throw Error('dialog did not open');};
test('real renderer dialogs block script until CDP responds and preserve synchronous return values',async()=>{
  let copied="";
  const browser=await createBrowser({spareRenderer:false,clipboard:{read:async()=>copied,write:async text=>{copied=text;}}});const server=CdpServer.create(browser.context).listen(0);
  const cdp=new CDP(`ws://127.0.0.1:${server.port}/devtools/browser/cdp-server`);
  try{
    await cdp.ready;const {targetId}=await cdp.send('Target.createTarget',{url:'about:blank'});
    cdp.sessionId=(await cdp.send('Target.attachToTarget',{targetId,flatten:true})).sessionId;
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate',{url:'data:text/html,<title>Dialog test</title><p>hello</p>'});
    let count=0;
    async function answer(expression,type,message,accept,promptText=''){
      let done=false;
      const result=cdp.send('Runtime.evaluate',{expression,returnByValue:true}).then(value=>{done=true;return value;});
      await until(()=>cdp.events.filter(e=>e.method==='Page.javascriptDialogOpening').length>count);
      const event=cdp.events.filter(e=>e.method==='Page.javascriptDialogOpening')[count++];
      expect(event.params).toMatchObject({type,message});expect(done).toBe(false);
      await cdp.send('Page.handleJavaScriptDialog',{accept,promptText});
      return (await result).result.value;
    }
    expect(await answer('alert(1+2); 42','alert','3',true)).toBe(42);
    expect(await answer('confirm("yes?")','confirm','yes?',true)).toBe(true);
    expect(await answer('confirm("no?")','confirm','no?',false)).toBe(false);
    expect(await answer('prompt("name", "default")','prompt','name',true,'  中文 😀  ')).toBe('  中文 😀  ');
    expect(await answer('prompt("empty")','prompt','empty',true,'')).toBe('');
    expect(await answer('prompt("cancel")','prompt','cancel',false)).toBe(null);
    const nav=cdp.send('Page.navigate',{url:'javascript:alert(1+2)'});
    await until(()=>cdp.events.filter(e=>e.method==='Page.javascriptDialogOpening').length>count);
    await cdp.send('Page.handleJavaScriptDialog',{accept:true});await nav;
    // Browser UI works through ordinary input, including long selectable messages.
    const ui=cdp.send('Runtime.evaluate',{expression:'alert("long message\\n".repeat(200)); 99',returnByValue:true});
    await until(()=>Boolean(browser.context.dialogState));
    const shot=await cdp.send('Page.captureScreenshot',{format:'png'});
    await Bun.write('/tmp/browser-alert.png',Buffer.from(shot.data,'base64'));
    const evaluate=async expression=>(await cdp.send('Runtime.evaluate',{expression,returnByValue:true})).result.value;
    expect(await evaluate('document.getElementById("message").scrollHeight > document.getElementById("message").clientHeight')).toBe(true);
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:300,y:150,deltaX:0,deltaY:250});
    expect(await evaluate('document.getElementById("message").scrollTop')).toBeGreaterThan(0);
    await evaluate('const r=document.createRange();r.selectNodeContents(document.getElementById("message"));window.getSelection().removeAllRanges();window.getSelection().addRange(r);');
    expect(await evaluate('window.getSelection().toString().length')).toBeGreaterThan(1000);
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'c',code:'KeyC',modifiers:2});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'c',code:'KeyC',modifiers:2});
    expect(copied.length).toBeGreaterThan(1000);
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:320,height:240,deviceScaleFactor:1});
    const small=await cdp.send('Page.captureScreenshot',{format:'png'});const pixels=Buffer.from(small.data,'base64');
    expect([pixels.readUInt32BE(16),pixels.readUInt32BE(20)]).toEqual([320,240]);
    await Bun.write('/tmp/browser-alert-small.png',pixels);
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter'});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter'});
    expect((await ui).result.value).toBe(99);
    const input=cdp.send('Runtime.evaluate',{expression:'prompt("Your name", "default")',returnByValue:true});
    await until(()=>Boolean(browser.context.dialogState));
    await cdp.send('Input.insertText',{text:'Alice'});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter'});
    expect((await input).result.value).toBe('Alice');
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter'});
    await cdp.send('Page.navigate',{url:'data:text/html,'+encodeURIComponent(`<button id="ask" onclick="window.answer=confirm('From a page click')">Ask</button>`)});
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',x:20,y:18});
    const clicked=cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',x:20,y:18});
    await until(()=>Boolean(browser.context.dialogState));
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});
    await clicked;
    expect((await cdp.send('Runtime.evaluate',{expression:'window.answer',returnByValue:true})).result.value).toBe(false);
    // Inline scripts can pause document loading, without blocking the modal UI.
    const loading=cdp.send('Page.navigate',{url:'data:text/html,'+encodeURIComponent('<script>alert("During load");window.loadedAfterDialog=true;</script>')});
    await until(()=>browser.context.dialogState?.message==='During load');
    await cdp.send('Page.captureScreenshot',{format:'png'});
    await cdp.send('Page.handleJavaScriptDialog',{accept:true});
    await loading;
    expect(await evaluate('window.loadedAfterDialog')).toBe(true);
    // Reload cancels the old dialog before waiting on its blocked renderer.
    await cdp.send('Page.navigate',{url:'about:blank'});
    const pending=cdp.send('Runtime.evaluate',{expression:'confirm("Reload me")',returnByValue:true});
    await until(()=>Boolean(browser.context.dialogState));
    await cdp.send('Page.reload');
    expect((await pending).result.value).toBe(false);
    expect(browser.context.dialogState).toBe(null);
  }finally{cdp.close();server.stop(true);browser.close();}
},30000);
