import CSSPropertyManager from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/CSSPropertyManager.ts';
import CSSTextParser from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/utilities/CSSTextParser.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';
import {parseDeclarationText} from './css-text-parser.js';
import {normalizeOverflow, overflowWide} from '../style/overflow-values.js';
import {parseCSSComponentValues} from '../style/css-value-tokens.js';

const axes = ['overflow-x', 'overflow-y'];
const logicalAxes=['overflow-inline','overflow-block'];
const pending = value => Boolean(parseCSSComponentValues(value)?.pending);
const split = value => {
  if (pending(value)) return axes.map(() => ({overflowSource:value}));
  const [x, y = x] = value.split(' ');return [x,y];
};
// CSS-text parsing applies priority independently to the expanded longhands.
// CSSOM setProperty intentionally replaces an existing declaration's priority.
CSSTextParser.parse = function(input) {
  const result = parseDeclarationText(input);
  const expanded = result.rules.flatMap(rule => {
    const name=rule.name.toLowerCase(),value=normalizeOverflow(name,rule.value);
    if(value===undefined)return [rule];
    if(value===null)return [];
    return name==='overflow' ? split(value).map((value,index) => ({...rule,name:axes[index],value})) : [{...rule,name,value}];
  });
  // Keep each winning axis at its final source position. The vendor manager
  // otherwise updates an existing key in place across `all`/logical axes.
  const winners=new Map();
  for(const rule of expanded)if(axes.includes(rule.name)||logicalAxes.includes(rule.name)) {
    if(rule.important||!winners.get(rule.name)?.important)winners.set(rule.name,rule);
  }
  result.rules=expanded.filter(rule=>!winners.has(rule.name)||winners.get(rule.name)===rule);
  return result;
};
const set = CSSPropertyManager.prototype.set;
const get = CSSPropertyManager.prototype.get;
const remove = CSSPropertyManager.prototype.remove;
const toString = CSSPropertyManager.prototype.toString;
function reorderLogicalAxis(manager,name) {
  const names=Object.keys(manager.properties),index=names.indexOf(name);
  if(index<0)return;
  const opposite=axes.includes(name)?logicalAxes:axes;
  if(names.slice(index+1).some(property=>opposite.includes(property)))remove.call(manager,name);
}
CSSPropertyManager.prototype.set = function(name, value, important) {
  if (axes.includes(name) && value && typeof value === 'object' && typeof value.overflowSource === 'string') {
    // Keep pending substitution on each affected axis. Its CSSOM value is
    // empty, but its source survives later changes to the other axis.
    reorderLogicalAxis(this,name);
    const result = set.call(this,name,'initial',important);
    this.properties[name] = {value:'',important,overflowSource:value.overflowSource};
    return result;
  }
  const normalized = value === null ? undefined : normalizeOverflow(name,value);
  if (normalized === null) return [];
  if (normalized === undefined) return set.call(this,name,value,important);
  name = name.toLowerCase();
  if (name !== 'overflow') {reorderLogicalAxis(this,name);return set.call(this,name,normalized,important);}
  return split(normalized).flatMap((value,index) => this.set(axes[index],value,important));
};
CSSPropertyManager.prototype.get = function(name) {
  if (name !== 'overflow') return get.call(this,name);
  const x=get.call(this,axes[0]), y=get.call(this,axes[1]);
  if (!x || !y || Boolean(x.important) !== Boolean(y.important)) return null;
  if (x.overflowSource || y.overflowSource) return x.overflowSource && x.overflowSource === y.overflowSource
    ? {value:x.overflowSource,important:x.important} : null;
  if (pending(x.value) || pending(y.value)) return null;
  if (x.value !== y.value && (overflowWide(x.value) || overflowWide(y.value))) return null;
  return {value:x.value === y.value ? x.value : `${x.value} ${y.value}`,important:x.important};
};
CSSPropertyManager.prototype.remove = function(name) {
  remove.call(this,name);
  if (name === 'overflow') for (const axis of axes) remove.call(this,axis);
};
CSSPropertyManager.prototype.toString = function() {
  const x=this.properties[axes[0]], y=this.properties[axes[1]];
  if (!x?.overflowSource || x.overflowSource !== y?.overflowSource || Boolean(x.important) !== Boolean(y.important))
    return toString.call(this);
  // Reassemble at its original declaration position: appending the shorthand
  // after `all` or logical overflow would change a cssText round trip.
  const clone=this.clone();
  for(const axis of axes)clone.properties[axis].value=x.overflowSource;
  let emitted=false;
  return parseDeclarationText(toString.call(clone)).rules.flatMap(rule=>{
    if(axes.includes(rule.name)) {
      if(emitted)return [];
      emitted=true;rule={...rule,name:'overflow'};
    }
    return `${rule.name}: ${rule.value}${rule.important?' !important':''};`;
  }).join(' ');
};

// Standard CSSOM serializes a lone pending longhand with an empty value. The
// renderer must retain its declaration source rather than reparse that lossy
// serialization. Snapshot only rules that actually have pending overflow.
export function pendingOverflowDeclarations(style) {
  if (!style) return null;
  const cache=style[S.cache],element=style[S.element];
  if (!cache.propertyManager || element && cache.attributeValue !== (element.getAttributeNS(null,'style') ?? '')) return null;
  const properties=cache.propertyManager.properties;
  if (!axes.some(axis=>properties[axis]?.overflowSource)) return null;
  const x=properties[axes[0]],y=properties[axes[1]];
  // An intact pending shorthand serializes losslessly and needs no metadata.
  if(x?.overflowSource&&x.overflowSource===y?.overflowSource&&Boolean(x.important)===Boolean(y.important))return null;
  const declarations=[],order={};
  // Use serialized declarations, not the manager's expanded margin/border
  // longhands. Mixing those indexes would move ordinary shorthands across all.
  const clone=cache.propertyManager.clone();
  for(const axis of axes)if(clone.properties[axis]?.overflowSource)clone.properties[axis].value='initial';
  for(const [index,rule] of parseDeclarationText(toString.call(clone)).rules.entries())order[rule.name]=index;
  for(const [name,property] of Object.entries(properties)) {
    if (!['overflow-x','overflow-y','overflow-inline','overflow-block'].includes(name)) continue;
    declarations.push({name,value:property.overflowSource ?? property.value,important:Boolean(property.important),pendingOverflow:Boolean(property.overflowSource),declarationIndex:order[name]});
  }
  return {declarations,order};
}
export function inlinePendingOverflow(element) { return pendingOverflowDeclarations(element[S.style]); }

export function restoreOverflowDeclarations(map,snapshot) {
  if (!snapshot) return map;
  for(const name of ['overflow','overflow-x','overflow-y','overflow-inline','overflow-block']) map.delete(name);
  for(const [name,declaration] of map) if(Object.hasOwn(snapshot.order,name)) declaration.declarationIndex=snapshot.order[name];
  for(const declaration of snapshot.declarations) map.set(declaration.name,{...declaration});
  return map;
}

// Changed CSSOM stylesheets can also contain partially overridden pending
// shorthands. Keep their snapshots alongside the internal source, never in
// serialized CSS exposed to pages. Ownership follows the existing sheet cache.
const sheetSnapshots=new WeakMap();
export function overflowSheetSource(text,snapshots) {
  if (!snapshots.size) return text;
  const source=Object.freeze({toString:()=>text});sheetSnapshots.set(source,snapshots);return source;
}
export function overflowSheetSnapshots(source) { return typeof source==='object' && source!==null ? sheetSnapshots.get(source) : undefined; }
