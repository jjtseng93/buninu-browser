// Experimental Qt-style GLSL fragment subset -> SkSL. No app-specific shaders.
// This is not a general GLSL compiler: unsupported syntax is rejected by SkSL,
// and unsupported interfaces/preprocessor features fail before compilation.
export function translateFragment(source) {
  if (/\b_qml_\w*/.test(String(source))) throw Error('Reserved shader adapter identifier');
  source=String(source).replace(/\/\*[\s\S]*?\*\//g,' ').replace(/\/\/[^\n]*/g,'');
  source=source.replace(/^\s*#version[^\n]*$/gm,'');
  if(/^\s*#/m.test(source))throw Error('Shader preprocessor directives are not implemented');
  if(/\b(?:gl_FragDepth|discard|samplerCube|sampler3D|image2D)\b/.test(source))throw Error('Unsupported fragment shader feature');
  source=source.replace(/layout\s*\([^)]*\)\s*/g,'');
  source=source.replace(/\bprecision\s+(?:lowp|mediump|highp)\s+\w+\s*;/g,'').replace(/\b(?:highp|mediump|lowp)\s+/g,'');
  const blocks=[];
  for(const m of source.matchAll(/struct\s+(\w+)\s*\{([^{}]*)\}\s*;/g)) {
    const matches=[...source.matchAll(new RegExp('uniform\\s+'+m[1]+'\\s+(\\w+)\\s*;','g'))];
    if(matches.length===1)blocks.push({declaration:m[0],body:m[2],uniform:matches[0][0],instance:matches[0][1]});
  }
  for(const block of blocks){
    source=source.replace(block.declaration,'').replace(block.uniform,block.body.split(';').filter(s=>s.trim()).map(s=>'uniform '+s.trim()+';').join('\n'));
    source=source.replace(new RegExp('\\b'+block.instance+'\\s*\\.\\s*','g'),'');
  }
  const samplers=[];
  source=source.replace(/uniform\s+sampler2D\s+(\w+)\s*;/g,(_,name)=>{
    samplers.push(name);
    return `uniform shader ${name}; uniform float2 _qml_size_${name};`;
  });
  source=source.replace(/uniform\s+\w+\s*\{([^{}]*)\}\s*;/g,(_,body)=>body.split(';').filter(s=>s.trim()).map(s=>'uniform '+s.trim()+';').join('\n'));
  let output=null,coordinates=false;
  source=source.replace(/\bin\s+vec2\s+qt_TexCoord0\s*;/g,()=>{coordinates=true;return 'float2 qt_TexCoord0;';});
  source=source.replace(/\bout\s+vec4\s+(\w+)\s*;/g,(_,name)=>{
    if(output)throw Error('Multiple fragment outputs are not supported');
    output=name;return `float4 ${name};`;
  });
  if(!output)throw Error('Fragment shader requires a vec4 output');
  if(/\b(?:in|out)\s+\w+\s+\w+\s*;/.test(source))throw Error('Unsupported fragment varying');
  const types={vec2:'float2',vec3:'float3',vec4:'float4',ivec2:'int2',ivec3:'int3',ivec4:'int4',bvec2:'bool2',bvec3:'bool3',bvec4:'bool4',mat2:'float2x2',mat3:'float3x3',mat4:'float4x4'};
  source=source.replace(/\b(?:[ib]?vec[234]|mat[234])\b/g,type=>types[type]);
  for (const call of source.matchAll(/\btextureSize\s*\(\s*\w+\s*,([^)]*)\)/g)) if (call[1].trim()!=='0') throw Error('Only base-level textureSize is supported');
  source=source.replace(/\b(texture|textureSize)\s*\(\s*(\w+)\s*,/g,(_,operation,name)=>{
    if(!samplers.includes(name))throw Error('Sampler expressions are not supported');
    return `_qml_${operation}_${name}(`;
  });
  if(!/\bvoid\s+main\s*\(\s*(?:void)?\s*\)/.test(source))throw Error('Missing fragment main');
  source=source.replace(/\bvoid\s+main\s*\(\s*(?:void)?\s*\)/,'void _qml_fragment()');
  source=source.replace(/\bround\s*\(/g,'_qml_round(');
  const rounding=['float','float2','float3','float4'].map(type=>`${type} _qml_round(${type} x) {return sign(x)*floor(abs(x)+0.5);}`).join('\n');
  const helpers=rounding+'\n'+samplers.map(name=>`float4 _qml_texture_${name}(float2 uv) {return ${name}.eval(uv * _qml_size_${name});}\nint2 _qml_textureSize_${name}(int lod) {return int2(_qml_size_${name});}`).join('\n');
  // Functions must follow their uniforms and precede their call sites.
  const mainAt=source.search(/\b(?:void|float\w*|int\w*|bool\w*)\s+\w+\s*\(/);
  source=source.slice(0,mainAt)+helpers+'\n'+source.slice(mainAt);
  return {samplers,source:`uniform float2 _qml_viewport;\n${source}\nhalf4 main(float2 p) {${coordinates?'qt_TexCoord0 = p / _qml_viewport;':''}${output}=float4(0);_qml_fragment();return half4(${output});}`};
}

export function compileFragment(kit, source) {
  const translated=translateFragment(source);
  let diagnostic='';
  const effect=kit.RuntimeEffect.Make(translated.source,message=>{diagnostic+=message;});
  if(!effect)throw Error('Software fragment compilation failed: '+diagnostic);
  return {...translated,effect};
}

// Reuse child shaders from the renderer's existing CanvasKit instance. The
// caller owns the returned shader, effect and children; no pixel readback here.
export function makeFragmentShader(compiled, {width,height,uniforms={},textures={}}) {
  const values=new Float32Array(compiled.effect.getUniformFloatCount());
  // CanvasKit converts integer uniforms from numeric float slots internally.
  const supplied={qt_Opacity:1,qt_Matrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],...uniforms,_qml_viewport:[width,height]};
  const children=compiled.samplers.map(name=>{
    const texture=textures[name];
    if(!texture?.shader || !(texture.width>0) || !(texture.height>0))throw Error('Missing shader texture: '+name);
    supplied['_qml_size_'+name]=[texture.width,texture.height];
    return texture.shader;
  });
  for(let i=0;i<compiled.effect.getUniformCount();i++){
    const name=compiled.effect.getUniformName(i),info=compiled.effect.getUniform(i);
    const count=info.columns*info.rows;
    const value=supplied[name] ?? Array(count).fill(0);
    const parts=typeof value==='number' ? [value] : Array.from(value);
    if(parts.length!==count)throw Error('Wrong shader uniform size: '+name);
    if(parts.some(v=>!Number.isFinite(v)))throw Error('Nonfinite shader uniform: '+name);
    values.set(parts,info.slot);
  }
  return compiled.effect.makeShaderWithChildren(values,children);
}
