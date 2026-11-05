import {parseCSSComponentValues} from './css-value-tokens.js';
import {lengthPercentage} from './sizing-values.js';
import {normalizeBackgroundSize} from './background-size-values.js';
import {serializeComputedColor} from './cssom-color.js';

const wide=new Set(['initial','inherit','unset','revert','revert-layer']);
export const BACKGROUND_DEFAULTS=Object.freeze({
  'background-image':'none','background-position-x':'0%','background-position-y':'0%',
  'background-size':'auto','background-repeat':'repeat','background-attachment':'scroll',
  'background-origin':'padding-box','background-clip':'border-box','background-color':'transparent',
});
const names=Object.keys(BACKGROUND_DEFAULTS),positions=['background-position-x','background-position-y'];
const repeats=new Set(['repeat','no-repeat','round','space']);
const boxes=new Set(['border-box','padding-box','content-box']);
const attachments=new Set(['scroll','fixed','local']);
const horizontal=new Set(['left','right']),vertical=new Set(['top','bottom']);
const word=t=>t?.kind==='ident'?t.value.toLowerCase():null;
const text=t=>t.kind==='ident'?t.value.toLowerCase():t.kind==='hash'?`#${t.value}`:
  t.kind==='dimension'||t.kind==='number'?`${t.value}${t.unit??''}`:t.source;
const split=tokens=>{const layers=[[]];for(const t of tokens)t.kind===','?layers.push([]):layers.at(-1).push(t);return layers;};
const trim=value=>String(value).trim();
function signedLength(token) {
  if(!token)return null;
  if(token.kind==='dimension'&&Number(token.value)<0) {
    const positive=lengthPercentage({...token,value:String(-Number(token.value))});return positive===null?null:`-${positive}`;
  }
  return lengthPercentage(token);
}
function color(token) {
  const value=text(token);if(value==='currentcolor')return value;
  // light-dark() is already evaluated by the style engine. Preserve it until
  // the element's color-scheme is known instead of rejecting that working path.
  if(token.kind==='function'&&token.name==='light-dark') {
    const choices=split(token.args);
    return choices.length===2&&choices.every(choice=>choice.length===1&&color(choice[0])!==null)?token.source:null;
  }
  const rgba=value&&Bun.color(value,'rgba');if(!/^rgba?\(/.test(rgba??''))return null;
  return token.kind==='hash'||token.kind==='function'?serializeComputedColor(rgba):value;
}
function image(token) {
  if(word(token)==='none')return 'none';
  if(token.kind!=='function')return null;
  if(token.name==='url') {
    const raw=token.source.slice(token.source.indexOf('(')+1,-1).trim();
    if(!raw)return 'url("")';
    // Retain CSS escapes inside quoted strings; unquoted URLs need quoting
    // when serialized so spaces and punctuation cannot become new components.
    if(raw[0]==='"'||raw[0]==="'")return token.args.length===1&&token.args[0].kind==='string'&&raw.at(-1)===raw[0]?`url(${raw})`:null;
    for(let i=0;i<raw.length;i++) {
      if(raw[i]==='\\') {
        if(i+1===raw.length||/[\n\r\f]/.test(raw[i+1]))return null;
        const hex=/^[\da-f]{1,6}/i.exec(raw.slice(i+1,i+7));
        if(hex) {i+=hex[0].length;if(raw[i+1]==='\r'&&raw[i+2]==='\n')i++;if(/[ \t\n\r\f]/.test(raw[i+1]??''))i++;}
        else i++;
      } else if(/[\x00-\x20\x7f"'()]/.test(raw[i]))return null;
    }
    return `url("${raw}")`;
  }
  // Preserve the CSSOM's pre-existing conic syntax too; the software painter
  // still only renders linear/radial gradients and is not expanded here.
  return /^(?:repeating-)?(?:linear|radial|conic)-gradient$/.test(token.name)?token.source:null;
}
function axis(tokens,dimension) {
  if(tokens.length===1) {
    const key=word(tokens[0]);if(key==='center'||(dimension===0?horizontal:vertical).has(key))return key;
    return signedLength(tokens[0]);
  }
  if(tokens.length===2&&(dimension===0?horizontal:vertical).has(word(tokens[0]))) {
    const offset=signedLength(tokens[1]);return offset===null?null:`${word(tokens[0])} ${offset}`;
  }
  return null;
}
export function backgroundPositionAxes(tokens) {
  if(tokens.length===1) {
    const value=text(tokens[0]);if(vertical.has(word(tokens[0])))return ['center',value];
    return axis(tokens,0)===null?null:[axis(tokens,0),'center'];
  }
  if(tokens.length===2) {
    let [a,b]=tokens;
    if(word(a)&&word(b)&&(vertical.has(word(a))||horizontal.has(word(b)))) [a,b]=[b,a];
    const x=axis([a],0),y=axis([b],1);return x===null||y===null?null:[x,y];
  }
  if(tokens.length<3||tokens.length>4)return null;
  const groups=[];
  for(let i=0;i<tokens.length;i++) {
    const key=word(tokens[i]);if(!horizontal.has(key)&&!vertical.has(key)&&key!=='center')return null;
    const group=[tokens[i]];if(signedLength(tokens[i+1])!==null)group.push(tokens[++i]);groups.push(group);
  }
  if(groups.length!==2)return null;
  let [a,b]=groups;if(vertical.has(word(a[0]))||horizontal.has(word(b[0]))) [a,b]=[b,a];
  const x=axis(a,0),y=axis(b,1);return x===null||y===null?null:[x,y];
}
function layer(tokens,last) {
  if(!tokens.length)return null;
  const result={...BACKGROUND_DEFAULTS},seen=new Set(),boxValues=[];let position=null;
  for(let i=0;i<tokens.length;) {
    const token=tokens[i],key=word(token),picture=image(token);
    if(picture!==null) {if(seen.has('image'))return null;seen.add('image');result['background-image']=picture;i++;continue;}
    if(attachments.has(key)) {if(seen.has('attachment'))return null;seen.add('attachment');result['background-attachment']=key;i++;continue;}
    if(repeats.has(key)||key==='repeat-x'||key==='repeat-y') {
      if(seen.has('repeat'))return null;seen.add('repeat');let value=key;i++;
      if(repeats.has(key)&&repeats.has(word(tokens[i])))value+=` ${word(tokens[i++])}`;
      result['background-repeat']=value;continue;
    }
    if(boxes.has(key)||key==='text'||key==='border-area') {
      boxValues.push(key);i++;
      continue;
    }
    const paint=color(token);
    if(paint!==null) {if(!last||seen.has('color'))return null;seen.add('color');result['background-color']=paint;i++;continue;}
    if(position)return null;
    const parts=[];
    while(i<tokens.length&&(word(tokens[i])==='center'||horizontal.has(word(tokens[i]))||vertical.has(word(tokens[i]))||signedLength(tokens[i])!==null))parts.push(tokens[i++]);
    if(!(position=backgroundPositionAxes(parts)))return null;
    [result['background-position-x'],result['background-position-y']]=position;
    if(tokens[i]?.kind==='/') {
      i++;const sizes=[];
      while(i<tokens.length&&sizes.length<2) {
        const candidate=[...sizes,tokens[i]].map(text).join(' ');
        if(normalizeBackgroundSize('background-size',candidate,false)===null)break;
        sizes.push(tokens[i++]);if(['contain','cover'].includes(word(sizes[0])))break;
      }
      if(!sizes.length)return null;
      result['background-size']=normalizeBackgroundSize('background-size',sizes.map(text).join(' '),false);
    }
  }
  if(boxValues.length) {
    const visual=boxValues.filter(v=>boxes.has(v)),special=boxValues.filter(v=>!boxes.has(v));
    if(special.length) {
      if(visual.length>1||special.length>2||new Set(special).size!==special.length)return null;
      result['background-origin']=visual[0]??'border-box';result['background-clip']=['border-area','text'].filter(v=>special.includes(v)).join(' ');
    } else {if(visual.length>2)return null;result['background-origin']=visual[0];result['background-clip']=visual[1]??visual[0];}
  }
  return result;
}
export function backgroundLonghands(name) {
  if(name==='background')return names;
  if(name==='background-position')return positions;
  return names.includes(name)?[name]:null;
}
/** A shared expansion for CSSOM, stylesheet cascade and pending substitution.
 * Historical pendingBorder metadata is shared with border; it names the
 * source shorthand rather than assuming any particular property family. */
export function expandBackgroundValue(name,input,allowPending=true) {
  name=name.toLowerCase();const fields=backgroundLonghands(name);if(!fields)return undefined;
  const value=trim(input),parsed=parseCSSComponentValues(value);if(!parsed)return null;
  if(parsed.pending)return allowPending?fields.map(longhand=>({name:longhand,value,...(fields.length>1?{pendingBorder:name}:{})})):null;
  if(parsed.tokens.length===1&&wide.has(word(parsed.tokens[0])))return fields.map(name=>({name,value:word(parsed.tokens[0])}));
  const layers=split(parsed.tokens);if(layers.some(tokens=>!tokens.length))return null;
  if(name==='background') {
    const values=layers.map((tokens,i)=>layer(tokens,i===layers.length-1));if(values.some(v=>!v))return null;
    return fields.map(name=>({name,value:name==='background-color'?values.at(-1)[name]:values.map(v=>v[name]).join(', ')}));
  }
  if(name==='background-position') {
    const values=layers.map(backgroundPositionAxes);return values.some(v=>!v)?null:fields.map((name,i)=>({name,value:values.map(v=>v[i]).join(', ')}));
  }
  const values=layers.map(tokens=>{
    if(name==='background-size')return normalizeBackgroundSize(name,tokens.map(text).join(' '),false);
    if(name==='background-image')return tokens.length===1?image(tokens[0]):null;
    if(name==='background-color')return layers.length===1&&tokens.length===1?color(tokens[0]):null;
    if(name==='background-position-x'||name==='background-position-y')return axis(tokens,name.endsWith('-x')?0:1);
    const words=tokens.map(word);
    if(name==='background-repeat')return words.length===1&&['repeat-x','repeat-y'].includes(words[0])?words[0]:words.length<=2&&words.every(w=>repeats.has(w))?(words[0]===words[1]?words[0]:words.join(' ')):null;
    if(name==='background-origin')return words.length===1&&boxes.has(words[0])?words[0]:null;
    if(name==='background-attachment')return words.length===1&&attachments.has(words[0])?words[0]:null;
    if(name==='background-clip')return words.length===1&&boxes.has(words[0])?words[0]:words.length<=2&&words.every(w=>['text','border-area'].includes(w))&&new Set(words).size===words.length?['border-area','text'].filter(w=>words.includes(w)).join(' '):null;
    return null;
  });
  return values.includes(null)?null:[{name,value:values.join(', ')}];
}
export function serializeBackground(properties,name='background') {
  const fields=backgroundLonghands(name),parts=fields?.map(field=>properties[field]);
  if(!parts||parts.some(p=>!p)||parts.some(p=>Boolean(p.important)!==Boolean(parts[0].important)))return null;
  if(parts.some(p=>wide.has(p.value)))return parts.every(p=>p.value===parts[0].value)?{value:parts[0].value,important:parts[0].important}:null;
  const lists=parts.map(p=>split(parseCSSComponentValues(p.value)?.tokens??[]).map(tokens=>tokens.map(text).join(' ')));
  const count=lists[0].length;
  if(lists.some((list,i)=>fields[i]!=='background-color'&&list.length!==count))return null;
  const at=(field,index)=>lists[fields.indexOf(field)]?.[field==='background-color'?0:index];
  if(name==='background-position')return {value:Array.from({length:count},(_,i)=>positionPair(at(positions[0],i),at(positions[1],i))).join(', '),important:parts[0].important};
  if(name!=='background')return null;
  const result=[];
  for(let i=0;i<count;i++) {
    const values=[];
    if(at('background-image',i)!=='none')values.push(at('background-image',i));
    const x=at(positions[0],i),y=at(positions[1],i),size=at('background-size',i);
    if(x!=='0%'||y!=='0%'||size!=='auto')values.push(`${positionPair(x,y)}${size!=='auto'?` / ${size}`:''}`);
    for(const field of ['background-repeat','background-attachment'])if(at(field,i)!==BACKGROUND_DEFAULTS[field])values.push(at(field,i));
    const origin=at('background-origin',i),clip=at('background-clip',i);
    if(origin!=='padding-box'||clip!=='border-box')values.push(origin===clip?origin:(clip.includes('text')||clip.includes('border-area'))&&origin==='border-box'?clip:`${origin} ${clip}`);
    if(i===count-1&&at('background-color',i)!=='transparent')values.push(at('background-color',i));
    result.push(values.join(' ')||'none');
  }
  return {value:result.join(', '),important:parts[0].important};
}

function positionPair(x,y) {
  const a=parseCSSComponentValues(x)?.tokens??[],b=parseCSSComponentValues(y)?.tokens??[];
  // An edge-offset on one axis requires the three/four component grammar.
  // A bare length on the other axis must therefore name its starting edge.
  if(a.length===1&&b.length===2&&!word(a[0]))x=`left ${x}`;
  if(b.length===1&&a.length===2&&!word(b[0]))y=`top ${y}`;
  return `${x} ${y}`;
}

export const INITIAL_BACKGROUND_POSITIONS=Object.freeze([Object.freeze({unit:'%',value:0})]);
export function computedBackgroundPositions(input,resolve) {
  const layers=split(parseCSSComponentValues(input)?.tokens??[]);
  return Object.freeze(layers.map(tokens=>{
    const key=word(tokens[0]),fraction={left:0,top:0,center:50,right:100,bottom:100}[key];
    if(fraction===undefined)return resolve(text(tokens[0]));
    if(tokens.length===1)return Object.freeze({unit:'%',value:fraction});
    const offset=resolve(text(tokens[1]));
    if(fraction===0)return offset;
    if(typeof offset==='number')return Object.freeze({unit:'math',kind:'calc',px:-offset,percent:100});
    if(offset?.unit==='%')return Object.freeze({unit:'%',value:100-offset.value});
    return Object.freeze({unit:'math',kind:'sum',values:Object.freeze([Object.freeze({unit:'%',value:100}),Object.freeze({unit:'math',kind:'scale',factor:-1,value:offset})])});
  }));
}
export function joinBackgroundPositions(x,y) {
  const a=split(parseCSSComponentValues(x)?.tokens??[]).map(tokens=>tokens.map(text).join(' '));
  const b=split(parseCSSComponentValues(y)?.tokens??[]).map(tokens=>tokens.map(text).join(' '));
  return Array.from({length:Math.max(a.length,b.length)},(_,i)=>`${a[i%a.length]} ${b[i%b.length]}`).join(', ');
}
