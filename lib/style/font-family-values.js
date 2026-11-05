import {parseCSSComponentValues,trimCSSWhitespace} from './css-value-tokens.js';

const wide=new Set(['initial','inherit','unset','revert','revert-layer']);
const reserved=new Set([...wide,'default','revert-rule']);
const generics=new Set(['serif','sans-serif','cursive','fantasy','monospace','system-ui','ui-serif','ui-sans-serif','ui-monospace','ui-rounded','math']);
const scripts=new Set(['fangsong','kai','khmer-mul','nastaliq']);
export const isGenericFontFamily=name=>generics.has(name.toLowerCase())||/^generic\((fangsong|kai|khmer-mul|nastaliq)\)$/i.test(name);
const customIdent=token=>token.kind==='ident'&&!reserved.has(token.value.toLowerCase())&&!generics.has(token.value.toLowerCase());
const decodeString=source=>source.slice(1,-1).replace(/\\(?:([\da-f]{1,6})(?:\r\n|[ \t\n\r\f])?|(\r\n|[\n\r\f])|([\s\S]))/gi,
  (_,hex,newline,literal)=>hex?String.fromCodePoint(!parseInt(hex,16)||parseInt(hex,16)>0x10ffff||parseInt(hex,16)>=0xd800&&parseInt(hex,16)<=0xdfff?0xfffd:parseInt(hex,16)):newline?'':literal);
const quote=value=>'"'+value.replace(/["\\\x00-\x1f\x7f]/g,c=>c==='"'||c==='\\'?'\\'+c:'\\'+c.codePointAt(0).toString(16)+' ')+'"';
function serializeCustom(name) {
  const parsed=parseCSSComponentValues(name);
  return parsed?.tokens.length&&parsed.tokens.every(customIdent)&&parsed.tokens.map(t=>t.value).join(' ')===name?name:quote(name);
}
function family(tokens) {
  if(tokens.length===1) {
    const token=tokens[0],name=token.value?.toLowerCase();
    if(token.kind==='string')return {name:decodeString(token.source),generic:false};
    if(token.kind==='ident'&&generics.has(name))return {name,generic:true};
    if(token.kind==='function'&&token.name==='generic'&&token.args.length===1&&token.args[0].kind==='ident'&&scripts.has(token.args[0].value.toLowerCase()))return {name:`generic(${token.args[0].value.toLowerCase()})`,generic:true};
  }
  return tokens.length&&tokens.every(customIdent)?{name:tokens.map(t=>t.value).join(' '),generic:false}:null;
}

/** Canonical CSS text retains generic/custom identity through style and paint caches. */
export function parseFontFamily(input,allowPending=true) {
  const text=trimCSSWhitespace(String(input).replace(/\0/g,'\ufffd').toWellFormed()),parsed=parseCSSComponentValues(text);
  if(!parsed)return null;
  if(parsed.pending)return allowPending?{value:text,pending:true}:null;
  if(parsed.tokens.length===1&&parsed.tokens[0].kind==='ident'&&wide.has(parsed.tokens[0].value.toLowerCase()))return {value:parsed.tokens[0].value.toLowerCase(),wide:true};
  const groups=[[]];
  for(const token of parsed.tokens)if(token.kind===',')groups.push([]);else groups.at(-1).push(token);
  const entries=groups.map(family);if(entries.includes(null))return null;
  const families=Object.freeze(entries.map(entry=>entry.generic?entry.name:serializeCustom(entry.name)));
  return {value:families.join(', '),families,entries};
}
export function normalizeFontFamily(name,input,allowPending=true) {
  if(name.toLowerCase()!=='font-family')return undefined;
  return parseFontFamily(input,allowPending)?.value??null;
}

const entryCache=new Map();
export function fontFamilyEntry(serialized) {
  let entry=entryCache.get(serialized);
  if(!entry) {
    // Canonical unquoted custom names need no tokenization at lookup time.
    const name=serialized.startsWith('"')?decodeString(serialized):serialized;
    entry=Object.freeze({name,generic:!serialized.startsWith('"')&&isGenericFontFamily(name)});
    if(entryCache.size>=256)entryCache.clear();
    entryCache.set(serialized,entry);
  }
  return entry;
}

// The font shorthand's family tail must keep quoted spaces and punctuation.
// Component tokens already carry their original source; functions stay intact.
export function fontShorthandTokens(input) {
  const parsed=parseCSSComponentValues(String(input));
  if(!parsed)return null;
  return parsed.tokens.map(token=>token.source??(token.kind==='ident'?token.value:token.kind==='dimension'?token.value+token.unit:token.kind==='number'?token.value:token.kind));
}
