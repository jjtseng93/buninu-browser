import {strict as assert} from 'node:assert';
import {createPageRenderer,loadGraphics} from '../../lib/renderer/page-renderer.js';
const {CanvasKit}=await loadGraphics();
const original=CanvasKit.ParagraphBuilder.MakeFromFontCollection;
let checked=0;const missing=[];
CanvasKit.ParagraphBuilder.MakeFromFontCollection=function(...args){
 const builder=original.apply(this,args),add=builder.addText.bind(builder),build=builder.build.bind(builder);
 let text='';
 builder.addText=value=>{text+=value;return add(value)};
 builder.build=()=>{
  const paragraph=build(),layout=paragraph.layout.bind(paragraph);
  paragraph.layout=width=>{
   layout(width);
   if(width<10000 && text.trim()){
    const last=text.trimEnd().length-1;
    const rects=paragraph.getRectsForRange(last,last+1,CanvasKit.RectHeightStyle.Max,CanvasKit.RectWidthStyle.Tight);
    if(!rects.length)missing.push({text,width});
    checked++;
   }
  };
  return paragraph;
 };
 return builder;
};
const r=await createPageRenderer({});
try{
 for(const scale of [1,1.125,1.25,1.5,2]){
  r.resize(900,300,scale);
  await r.loadDocument({url:'https://text.test/',contentType:'text/html',source:`<body style="margin:0">
   <div style="display:flex;gap:24px;font-size:15.2px"><span>Contact</span><span>Ecosystem</span><span>Contributors</span></div>
   <div style="display:flex;gap:24px;font-size:14.4px"><span>Buninu Linux</span><span>Long navigation label</span></div>
   <button style="font:14.4px monospace">Show email address</button>
   </body>`});
  await r.whenLoaded();await r.screenshot();
 }
 assert.deepEqual(missing,[],'All painted lines must retain their final character');
 assert.ok(checked>=30,'All scales must exercise painted paragraphs');
}finally{r.dispose();CanvasKit.ParagraphBuilder.MakeFromFontCollection=original}
