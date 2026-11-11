// Optional QML adapter. The decoder and scheduling remain ordinary image resources.
export function attachQmlImageAnimation(element, animation) {
 if(!animation || !element.hasAttribute("data-qml-animation"))return;
 const ref=new WeakRef(element);
 const notify=()=>{
  const node=ref.deref();if(!node)return;
  const frame=String(animation.frame), count=String(animation.frameCount);
  if(node.getAttribute('data-qml-animation-frame')!==frame)node.setAttribute('data-qml-animation-frame',frame);
  if(node.getAttribute('data-qml-animation-count')!==count)node.setAttribute('data-qml-animation-count',count);
  node.dispatchEvent(new node.ownerDocument.defaultView.Event('qml-image-frame'));
 };
 const update=()=>{const node=ref.deref();if(node)animation.configure({playing:node.getAttribute("data-qml-animation-playing")!=="false",paused:node.getAttribute("data-qml-animation-paused")==="true"});};
 element.addEventListener('qml-image-animation',update);
 animation.onFrame=notify;
 animation.onDispose=()=>ref.deref()?.removeEventListener('qml-image-animation',update);
 update();notify();
}
