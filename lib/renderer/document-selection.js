// Keep engine nodes/ranges behind the same DOM wrappers as the rest of the realm.
export function selectionBinding(window, realm, nodeOf, changed) {
  const native=()=>window.getSelection();
  const api={};
  for(const key of ['anchorOffset','focusOffset','isCollapsed','rangeCount','type'])Object.defineProperty(api,key,{get:()=>native()[key]});
  for(const key of ['anchorNode','focusNode'])Object.defineProperty(api,key,{get:()=>realm.wrap(native()[key])});
  api.toString=()=>native().toString();
  api.getRangeAt=i=>realm.wrapRange(native().getRangeAt(i));
  const mutate=(name,args)=>{const result=native()[name](...args);changed();return result;};
  for(const name of ['removeAllRanges','empty','collapseToStart','collapseToEnd','deleteFromDocument'])api[name]=()=>mutate(name,[]);
  api.collapse=api.setPosition=(node,offset=0)=>mutate('collapse',[nodeOf(node),offset]);
  api.extend=(node,offset=0)=>mutate('extend',[nodeOf(node),offset]);
  api.setBaseAndExtent=(a,ao,f,fo)=>mutate('setBaseAndExtent',[nodeOf(a),ao,nodeOf(f),fo]);
  api.selectAllChildren=node=>mutate('selectAllChildren',[nodeOf(node)]);
  api.containsNode=(node,partial=false)=>native().containsNode(nodeOf(node),partial);
  api.addRange=range=>mutate('addRange',[realm.unwrapRange(range)]);
  api.removeRange=range=>mutate('removeRange',[realm.unwrapRange(range)]);
  return api;
}
