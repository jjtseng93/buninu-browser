// Serialized local QML adapter. Rendering remains an ordinary HTML canvas.
export function createQmlShaderEffects(api) {
  const {effect,untrack,elements,host,cleanup}=api;
  function make(v,type,element){
    if(type!=='ShaderEffect')return;
    Object.assign(v,{fragmentShader:'',vertexShader:'',status:0,log:'',blending:true,cullMode:0});
    const canvas=document.createElement('canvas');
    canvas.style.cssText='position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none';
    element.appendChild(canvas);
    let program=null,source=null,frame,disposed=false;
    const fail=e=>{v.status=2;v.log=String(e.message||e);};
    effect(()=>{
      const url=v.fragmentShader,vertex=v.vertexShader;
      untrack(()=>{
        if(url===source&&!vertex)return;
        source=url;program?.dispose();program=null;v.status=0;v.log='';
        if(!url)return;
        try{
          if(vertex)throw Error('Custom vertex shaders are not implemented');
          if(!host?.shader)throw Error('ShaderEffect requires a local QML renderer');
          program=host.shader(api.resolve(v,url));v.status=1;
        }catch(e){fail(e);}
      });
    });
    effect(()=>{
      v.status;v.fragmentShader;
      const width=Math.ceil(v.width),height=Math.ceil(v.height),smooth=v.smooth!==false;
      const uniforms={},inputs={};
      if(program){
        for(const name of program.uniforms){
          const value=v[name];
          uniforms[name]=value&&typeof value==='object' ? ('r' in value?[value.r,value.g,value.b,value.a]: 'x' in value?['x','y','z','w'].filter(k=>k in value).map(k=>value[k]):Array.from(value)):value;
        }
        for(const name of program.samplers){
          const value=v[name];
          if(!value)continue;
          value.status;value.source;
          const element=elements.get(value);
          inputs[name]=element?.querySelector('img,canvas');
          if(value.sourceItem!==undefined)inputs[name]=api.texture(value);
          inputs[name]={element:inputs[name],smooth:value.smooth!==false};
        }
      }
      untrack(()=>{
        cancelAnimationFrame(frame);
        if(!program||!(width>0&&height>0))return;
        if(width>8192||height>8192||width*height>16777216){fail(Error('ShaderEffect size limit'));return;}
        frame=requestAnimationFrame(()=>{
          if(disposed||!program)return;
          try{
            if(canvas.width!==width)canvas.width=width;
            if(canvas.height!==height)canvas.height=height;
            program.draw(canvas,uniforms,inputs,smooth);
          }catch(e){fail(e);}
        });
      });
    });
    cleanup(()=>{disposed=true;cancelAnimationFrame(frame);program?.dispose();canvas.remove();});
  }
  return {make};
}
