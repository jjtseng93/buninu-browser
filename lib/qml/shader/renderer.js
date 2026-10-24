import {readFileSync} from 'node:fs';
import {fragmentSource} from './qsb.js';
import {compileFragment,makeFragmentShader} from './fragment.js';

// Local-QML capability. Native handles never enter the document realm.
export function createShaderRenderer({kit,unwrap,valid,resource,paint,track}) {
  function node(value) {const n=unwrap(value)??value;if(!valid(n))throw Error('Invalid QML shader element');return n;}
  return url=>{
    const address=new URL(String(url));
    if(address.protocol!=='file:')throw Error('ShaderEffect requires a local shader file');
    const compiled=compileFragment(kit,fragmentSource(readFileSync(address)));
    let disposed=false;
    const stop=track(()=>{disposed=true;compiled.effect.delete();});
    const names=Array.from({length:compiled.effect.getUniformCount()},(_,i)=>compiled.effect.getUniformName(i)).filter(n=>!n.startsWith('_qml_')&&!['qt_Matrix','qt_Opacity'].includes(n));
    return {
      uniforms:names,samplers:compiled.samplers,
      dispose:stop,
      draw(target,uniforms,inputs,smooth=true) {
        if(disposed)throw Error('ShaderEffect is disposed');
        target=node(target);
        if(target.tagName!=='CANVAS')throw Error('ShaderEffect target must be a canvas');
        const children=[],textures={};let shader,p;
        try {
          for(const name of compiled.samplers){
            if(!inputs[name]?.element)return false;
            const r=resource(node(inputs[name].element));
            if(!r?.image)return false;
            const child=r.image.makeShaderOptions(kit.TileMode.Clamp,kit.TileMode.Clamp,inputs[name].smooth?kit.FilterMode.Linear:kit.FilterMode.Nearest,kit.MipmapMode.None);
            children.push(child);textures[name]={shader:child,width:r.width,height:r.height};
          }
          shader=makeFragmentShader(compiled,{width:target.width,height:target.height,uniforms,textures});
          p=new kit.Paint();p.setShader(shader);p.setBlendMode(kit.BlendMode.Src);
          paint(target,canvas=>canvas.drawRect(kit.XYWHRect(0,0,target.width,target.height),p));
          return true;
        }finally{p?.delete();shader?.delete();for(const child of children)child.delete();}
      },
    };
  };
}
