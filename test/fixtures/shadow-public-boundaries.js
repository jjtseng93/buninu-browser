// Also evaluated unchanged in Chromium for the public-boundary comparison.
export function shadowPublicBoundaries() {
  document.body.innerHTML = '<style>body{margin:0;height:120px}</style><div id="outside"></div>';
  const outside = document.getElementById('outside'), result = [];
  for (const modes of [['open'], ['closed'], ['open','open'], ['open','closed'], ['closed','open'], ['closed','closed']]) {
    const host = document.createElement('div');host.id='host';host.style.cssText='width:80px;height:80px';document.body.prepend(host);
    const root = host.attachShadow({mode:modes[0]});let inner = root;
    if (modes.length===2) {
      const nested = document.createElement('div');nested.id='nested';nested.style.cssText='width:80px;height:80px';root.append(nested);
      inner = nested.attachShadow({mode:modes[1]});
    }
    inner.innerHTML='<div id="private" style="width:80px;height:80px;background:red"></div>';
    const target=inner.firstChild, hits=[document.elementFromPoint(10,10)?.id,document.elementsFromPoint(10,10).map(node=>node.id||node.tagName)];
    const seen=[];
    const listen=(node,name)=>{
      const callback=e=>seen.push([name,e.target?.id??null,e.srcElement?.id??null,e.relatedTarget?.id??null]);
      node.addEventListener('probe',callback);return()=>node.removeEventListener('probe',callback);
    };
    const cleanups=[listen(target,'target'),listen(inner,'inner')];
    if(inner!==root)cleanups.push(listen(inner.host,'nested'),listen(root,'outer'));
    cleanups.push(listen(host,'host'),listen(document,'document'));
    const composed=new MouseEvent('probe',{bubbles:true,composed:true});target.dispatchEvent(composed);
    const crossing=seen.splice(0),after=[composed.target?.id??null,composed.relatedTarget?.id??null];
    const local=new MouseEvent('probe',{bubbles:true,composed:false});target.dispatchEvent(local);
    const localEvents=seen.splice(0),localAfter=[local.target?.id??null,local.relatedTarget?.id??null];
    for(const cleanup of cleanups)cleanup();
    result.push({modes,hits,crossing,after,localEvents,localAfter});host.remove();
  }
  // Assigned light DOM remains document-owned; retargeting must not hide it.
  const host=document.createElement('div');host.id='slot-host';host.innerHTML='<b id="light" style="display:block;width:80px;height:80px;background:red"></b>';document.body.prepend(host);
  const root=host.attachShadow({mode:'closed'});root.innerHTML='<slot></slot>';
  const light=host.firstChild, slotted=[];
  const record=e=>slotted.push(e.target?.id??null);
  host.addEventListener('probe',record);document.addEventListener('probe',record);
  const event=new Event('probe',{bubbles:true,composed:true});light.dispatchEvent(event);
  result.push({slotted,hits:[document.elementFromPoint(10,10)?.id,document.elementsFromPoint(10,10).map(node=>node.id||node.tagName)],after:event.target?.id??null});
  document.removeEventListener('probe',record);host.remove();
  // The event's path is a snapshot, even when a listener detaches its target.
  for(const composed of [false,true]) {
    const host=document.createElement('div');host.id='move-host';document.body.append(host);
    const root=host.attachShadow({mode:'closed'}),target=document.createElement('i');target.id='moving';root.append(target);
    const values=[];const callback=e=>values.push(e.target?.id??null);document.addEventListener('move',callback);
    target.addEventListener('move',()=>document.body.append(target));
    const event=new Event('move',{bubbles:true,composed});target.dispatchEvent(event);
    result.push({moved:composed,values,after:event.target?.id??null});
    document.removeEventListener('move',callback);target.remove();host.remove();
  }
  return result;
}
