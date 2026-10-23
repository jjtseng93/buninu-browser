// Optional local-QML bridge to the frontend's standard Wayland clipboard.
// Ordinary HTML never needs this HTTP endpoint. Create it lazily before the
// first local QML navigation, including navigation after an about:blank launch.
export async function attachQmlClipboard(client,browser,done) {
  const clipboard=client.clipboard;
  if(!clipboard)return;
  const navigate=browser.context.navigate;
  let server,setup,closed=false;
  const prepare=()=>setup??=(async()=>{
    const token=crypto.randomUUID();
    server=Bun.serve({hostname:'127.0.0.1',port:0,maxRequestBodySize:1024*1024+1024,
      async fetch(request) {
        if(request.method!=='POST'||new URL(request.url).pathname!=='/'+token||request.headers.has('origin'))return new Response(null,{status:403});
        try {
          const {operation,text}=await request.json();
          if(operation==='read')return Response.json({text:await clipboard.read()});
          if(operation!=='write'||typeof text!=='string')return new Response(null,{status:400});
          await clipboard.write(text);return Response.json({});
        }catch{return new Response(null,{status:503});}
      }});
    await browser.context.addInitScript(`globalThis.__qmlHost?.setClipboardEndpoint(${JSON.stringify(`http://127.0.0.1:${server.port}/${token}`)});`);
  })();
  const wrapped=async function(url,...args) {
    if(!closed&&/^file:.*\.qml(?:[?#]|$)/i.test(String(url)))await prepare();
    return navigate.call(this,url,...args);
  };
  browser.context.navigate=wrapped;
  done.finally(()=>{
    closed=true;server?.stop(true);
    if(browser.context.navigate===wrapped)browser.context.navigate=navigate;
  });
}
