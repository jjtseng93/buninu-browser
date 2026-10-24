// Optional frontend adapter; xdg_toplevel size hints, not an application check.
export function qmlWindowConstraints(client,window,context) {
  let previous='';
  return async()=>{
    if(!previous&&!/\.qml(?:[?#]|$)/i.test(context.url||''))return;
    const hints=await context.evaluate(`(()=>{const elements=[...document.querySelectorAll('[data-qml-window-min]')];const e=elements.find(e=>e.style.display!=='none');return e?[e.getAttribute('data-qml-window-min'),e.getAttribute('data-qml-window-max')]:null;})()`);
    const key=JSON.stringify(hints);if(previous===key)return;
    const parse=value=>{try{return JSON.parse(value).map(n=>Number.isFinite(n)?Math.max(0,Math.min(8192,Math.ceil(n))):0);}catch{return [0,0];}};
    const min=parse(hints?.[0]),max=parse(hints?.[1]);
    for(let i=0;i<2;i++)if(max[i]&&max[i]<min[i])max[i]=min[i];
    client.request(window.toplevel,'set_min_size',...min);
    client.request(window.toplevel,'set_max_size',...max);
    client.request(window.surface,'commit');
    previous=key;
  };
}
