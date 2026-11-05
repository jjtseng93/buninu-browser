import {parseCSSComponentValues} from './css-value-tokens.js';
import {lengthPercentage,computedSizingValue} from './sizing-values.js';

const wide=new Set(['initial','inherit','unset','revert','revert-layer']);
export const INITIAL_BACKGROUND_SIZES=Object.freeze([Object.freeze(['auto','auto'])]);

/** CSS Backgrounds 3: each comma-separated layer has one fit keyword or
 * one/two nonnegative length-percentages/auto axes. Functions keep their own
 * commas; negative math is range-clamped only after substitution/computation. */
export function backgroundSizeLayers(input) {
  const parsed=parseCSSComponentValues(String(input));
  if(!parsed||parsed.pending)return null;
  const layers=[],tokens=[];
  const finish=()=>{
    if(!tokens.length||tokens.length>2)return false;
    if(tokens.length===1&&tokens[0].kind==='ident'&&['cover','contain'].includes(tokens[0].value.toLowerCase())) {
      layers.push(tokens[0].value.toLowerCase());tokens.length=0;return true;
    }
    const axes=tokens.map(token=>token.kind==='ident'&&token.value.toLowerCase()==='auto'?'auto':lengthPercentage(token));
    if(axes.includes(null))return false;
    layers.push([axes[0],axes[1]??'auto']);tokens.length=0;return true;
  };
  for(const token of parsed.tokens) {
    if(token.kind===',') {if(!finish())return null;} else tokens.push(token);
  }
  return finish()?layers:null;
}

export function serializeBackgroundLength(value,serialize=String) {
  const axis=value=>serializeBackgroundLength(value,serialize);
    if(value?.unit!=='math')return serialize(value);
    if(value.kind==='calc') {
      if(value.percent===0)return serialize(value.px);
      if(value.px===0)return `${value.percent}%`;
      return `calc(${value.percent}% ${value.px<0?'-':'+'} ${serialize(Math.abs(value.px))})`;
    }
    if(value.kind==='scale')return `calc(${value.factor} * ${axis(value.value)})`;
    if(value.kind==='sum')return `calc(${value.values.map(axis).join(' + ')})`;
    return `${value.kind}(${value.values.map(axis).join(', ')})`;
}
export function serializeBackgroundSizes(layers,serialize=String) {
  const axis=value=>serializeBackgroundLength(value,serialize);
  return layers.map(layer=>typeof layer==='string'?layer:layer.every(value=>value==='auto')?'auto':layer.map(axis).join(' ')).join(', ');
}

/** undefined: unrelated, null: invalid, string: canonical specified/pending. */
export function normalizeBackgroundSize(name,input,allowPending=true) {
  if(name.toLowerCase()!=='background-size')return undefined;
  const text=String(input).trim(),parsed=parseCSSComponentValues(text);
  if(!parsed)return null;
  if(parsed.pending)return allowPending?text:null;
  if(parsed.tokens.length===1&&parsed.tokens[0].kind==='ident'&&wide.has(parsed.tokens[0].value.toLowerCase()))return parsed.tokens[0].value.toLowerCase();
  const layers=backgroundSizeLayers(text);
  return layers?serializeBackgroundSizes(layers):null;
}

/** Percentages retain the background positioning area as their eventual basis. */
export function computedBackgroundSizes(input,resolve) {
  const layers=backgroundSizeLayers(input);
  if(!layers)return INITIAL_BACKGROUND_SIZES;
  return Object.freeze(layers.map(layer=>typeof layer==='string'?layer:Object.freeze(layer.map(axis=>
    axis==='auto'?axis:computedSizingValue(axis,resolve)))));
}
