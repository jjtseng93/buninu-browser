// Kept outside the DOM so moving a dialog into the top layer does not
// change parentNode, selector matching, or event propagation.
const dialogs=new WeakMap();
export function modalDialogs(document) {
  const list=dialogs.get(document);
  if (!list) return [];
  for(let i=list.length-1;i>=0;i--) if(!list[i].isConnected || !list[i].open || list[i].ownerDocument!==document)list.splice(i,1);
  return list;
}
export function pushModal(node) {
  const list=modalDialogs(node.ownerDocument);
  list.push(node);
  dialogs.set(node.ownerDocument,list);
}
export function popModal(node) {
  const list=modalDialogs(node.ownerDocument), index=list.indexOf(node);
  if(index>=0)list.splice(index,1);
}
export function activeModal(document) {
  return dialogs.has(document) ? modalDialogs(document).at(-1) : undefined;
}
