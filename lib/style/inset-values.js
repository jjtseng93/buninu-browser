import {parseCSSComponentValues} from './css-value-tokens.js';
import {normalizeMargin,expandMargin} from './margin-values.js';
import {supportsLengthUnits} from './table-values.js';

const physical=['top','right','bottom','left'];
const axes=new Map(['block','inline'].map(axis=>[`inset-${axis}`,['start','end'].map(edge=>`inset-${axis}-${edge}`)]));
const single=new Map([...physical,...axes.values()].flat().map(name=>[name,[name]]));
const marginName=name=>physical.includes(name)?`margin-${name}`:name==='inset'?'margin':name.startsWith('inset-')?`margin-${name.slice(6)}`:null;
const insetName=name=>name.startsWith('margin-inline')||name.startsWith('margin-block')?`inset-${name.slice(7)}`:name.slice(7);

export function insetLonghands(name) {
  name=name.toLowerCase();
  return name==='inset'?physical:axes.get(name)??single.get(name)??null;
}

// Insets share the signed <length-percentage> | auto component grammar with
// margins. Their longhands and percentage bases remain distinct in layout.
export function normalizeInset(name,input,allowPending=true) {
  const mapped=marginName(name.toLowerCase());
  return mapped===null?undefined:normalizeMargin(mapped,input,allowPending);
}

export function expandInset(name,input,allowPending=true) {
  name=name.toLowerCase();
  const mapped=marginName(name);
  if(mapped===null)return undefined;
  const values=expandMargin(mapped,input,allowPending);
  return values?.map(part=>({...part,name:insetName(part.name),pendingBorder:part.pendingBorder?name:undefined}))??values;
}

export function supportsInset(name,input) {
  const value=normalizeInset(name,input);
  if(value===undefined)return undefined;
  if(value===null)return false;
  const parsed=parseCSSComponentValues(value);
  return parsed.pending||supportsLengthUnits(parsed.tokens);
}
