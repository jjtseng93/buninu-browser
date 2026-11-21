// A WebEngineView's HTTP document uses the normal isolated browser renderer.
// No QML host capability or parent window is endowed to the embedded web page.
import {readFileSync,unlinkSync} from 'node:fs';
export function createWebView({onFrame,onState,clipboard}) {
  let browser,closed=false,visible=true,dirty=false,capturing=false,timer=null;
  let width=640,height=480,dpr=1,queue=Promise.resolve();
  let loading=false;
  const start=url=>{loading=true;onState({loading:true,url});};
  const finish=()=>{if(!closed){loading=false;onState({loaded:true,url:browser.context.url});dirty=true;schedule();}};
  const ready=import('../headless-shell.js').then(async({createBrowser})=>{
    const b=await createBrowser({allowHostJs:false,spareRenderer:false,waitForRenderer:false,clipboard,initialViewport:{width,height}});
    browser=b;
    if(closed){b.close();return b;}
    b.context.onFrame(()=>{dirty=true;schedule();});
    b.context.onNavigated(({url})=>{
      if(closed)return;
      onState({url});
    });
    b.context.onLifecycle(name=>{if(name==='load'&&!closed){if(!loading)start(b.context.url);finish();}});
    await b.ready;return b;
  });
  ready.catch(error=>{if(!closed)onState({error:String(error.message||error)});});
  function schedule(){if(!closed&&visible&&dirty&&!capturing&&!timer)timer=setTimeout(capture,16);}
  async function capture(){
    timer=null;if(closed||!visible||!dirty||!browser)return;
    capturing=true;dirty=false;
    try {
      const data=await browser.context.screenshot({format:'rgba'});
      if(!data)return;
      const frame=JSON.parse(data);
      let pixels;
      try {pixels=readFileSync(frame.path);}finally{try{unlinkSync(frame.path);}catch{}}
      if(!closed)onFrame({width:frame.width,height:frame.height,pixels:new Uint8Array(pixels.buffer,pixels.byteOffset,pixels.byteLength)});
    }catch(error){if(!closed)onState({error:String(error.message||error)});}
    finally{capturing=false;schedule();}
  }
  function invoke(fn){
    queue=queue.catch(()=>{}).then(async()=>{const b=await ready;if(!closed)return fn(b.context);});
    queue.catch(error=>{if(!closed)onState({error:String(error.message||error)});});
    return queue;
  }
  return {
    navigate(url){
      const u=new URL(url);if(!['http:','https:'].includes(u.protocol))throw Error('WebEngineView remote URLs must use HTTP(S)');
      return invoke(async ctx=>{start(u.href);await ctx.navigate(u.href);if(loading)finish();});
    },
    resize(w,h,scale=1){w=Math.max(1,Math.min(8192,Math.round(Number(w)||1)));h=Math.max(1,Math.min(8192,Math.round(Number(h)||1)));
      scale=Number.isFinite(scale)&&scale>0?Math.min(4,scale):1;
      if(w===width&&h===height&&scale===dpr)return;width=w;height=h;dpr=scale;return invoke(ctx=>ctx.resize(w,h,scale));},
    visible(value){visible=!!value;if(visible){dirty=true;schedule();}},
    input(type,value){return invoke(ctx=>{
      if(type==='key')return ctx.press(value.key,value);
      if(type==='text')return ctx.type(value.text);
      if(type==='move')return ctx.move(value.x,value.y,value);
      if(type==='wheel')return ctx.scroll(value.deltaX,value.deltaY,value,{modifiers:value.modifiers});
      if(type==='button')return Promise.resolve(ctx.click(value.x,value.y,value)).then(result=>{if(result?.url&&!closed){onState({url:result.url});if(loading)finish();}});
    });},
    reload(){return invoke(async ctx=>{start(ctx.url);await ctx.reload();if(loading)finish();});},
    back(){return invoke(async ctx=>{start(ctx.url);await ctx.goBack();if(loading)finish();});},
    forward(){return invoke(async ctx=>{start(ctx.url);await ctx.goForward();if(loading)finish();});},
    async dispose(){if(closed)return;closed=true;clearTimeout(timer);browser?.close();await ready.catch(()=>{});browser?.close();},
  };
}
