import {parseCSSComponentValues} from './css-value-tokens.js';
import {animationNumericToken} from './animation-numeric-values.js';
import {easingToken} from './easing-values.js';

// WebKit's historic animation properties are aliases, not expando properties.
export function animationProperty(name) {
  name = String(name);
  if(name.startsWith("--"))return name;
  if (/^webkitAnimation(?:[A-Z]|$)/.test(name)) name = name.slice(6);
  name = name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
  return name.replace(/^-webkit-(animation(?:-|$))/, '$1').replace(/^-animation/, 'animation');
}

export function animationLists(value) {
  return splitAnimationText(value, ',');
}

// Commas and spaces inside easing math or quoted animation names belong to a
// single component. A one-parenthesis regex splits nested min()/calc() calls.
function splitAnimationText(value,separator) {
  const source=String(value),parts=[];
  let depth=0,quote='',start=0;
  for(let i=0;i<source.length;i++) {
    const c=source[i];
    if(c==='\\'){i++;continue;}
    if(quote){if(c===quote)quote='';continue;}
    if(c==='"'||c==="'"){quote=c;continue;}
    if(c==='/'&&source[i+1]==='*') {
      const end=source.indexOf('*/',i+2);
      if(end<0)break;
      i=end+1;continue;
    }
    if(c==='(')depth++;
    else if(c===')')depth--;
    else if(depth===0&&(c===separator||separator===' '&&/[\t\n\r\f]/.test(c))) {
      parts.push(source.slice(start,i).trim());start=i+1;
    }
  }
  parts.push(source.slice(start).trim());return parts;
}


const defaults = {duration:'auto', timingFunction:'ease', delay:'0s', iterationCount:'1',
  direction:'normal', fillMode:'none', playState:'running', name:'none'};
const wide = new Set(['inherit','initial','unset','revert','revert-layer']);

function parseItem(tokens) {
  if (!tokens.length) return null;
  const fields = new Map();
  for (const token of tokens) {
    const keyword = token.kind === 'ident' ? token.value.toLowerCase() : '';
    let field, value;
    const timeField = fields.has('duration') ? 'delay' : 'duration';
    if (!fields.has(timeField) && (value = animationNumericToken('animation-' + timeField, token)) != null) field = timeField;
    else if (!fields.has('delay') && (value = animationNumericToken('animation-delay', token)) != null) field = 'delay';
    else if (!fields.has('timingFunction') && (value = easingToken(token)) != null) field = 'timingFunction';
    else if (!fields.has('iterationCount') && (value = animationNumericToken('animation-iteration-count',token)) != null) field = 'iterationCount';
    else if (!fields.has('direction') && ['normal','reverse','alternate','alternate-reverse'].includes(keyword)) { field='direction'; value=keyword; }
    else if (!fields.has('fillMode') && ['both','none','backwards','forwards'].includes(keyword)) { field='fillMode'; value=keyword; }
    else if (!fields.has('playState') && ['running','paused'].includes(keyword)) { field='playState'; value=keyword; }
    else if (!fields.has('name') && (token.kind === 'string' || keyword && !wide.has(keyword) && keyword !== 'default')) {
      field='name'; value=token.source;
    } else return null;
    fields.set(field,value);
  }
  return {...defaults,...Object.fromEntries(fields)};
}

function parseItems(tokens) {
  const items=[];
  let start=0;
  for(let i=0;i<=tokens.length;i++) {
    if(i<tokens.length && tokens[i].kind!==',') continue;
    const item=parseItem(tokens.slice(start,i));
    if(!item)return null;
    items.push(item);
    start=i+1;
  }
  return items;
}

export function normalizeAnimationShorthand(value, allowPending = true) {
  const parsed=parseCSSComponentValues(value);
  if(!parsed)return null;
  if(parsed.pending)return allowPending ? value : null;
  const tokens=parsed.tokens;
  if(tokens.length===1 && tokens[0].kind==='ident' && wide.has(tokens[0].value.toLowerCase()))return tokens[0].value.toLowerCase();
  return parseItems(tokens)?.map(item=>Object.values(item).join(' ')).join(', ') ?? null;
}

export function animationShorthand(value) {
  const parsed=parseCSSComponentValues(value);
  const items=parsed && parseItems(parsed.tokens);
  return items ?? [];
}
