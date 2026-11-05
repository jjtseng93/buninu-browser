import './css-border-properties.js';
import './css-background-properties.js';
import './css-sizing-properties.js';
import './css-margin-properties.js';
import './css-padding-properties.js';
import './css-inset-properties.js';
import './css-table-properties.js';
import './css-overflow.js';
import './css-opacity.js';
import './css-box-shadow.js';
import './css-animation-properties.js';
import './css-text-properties.js';
import './css-layout-keywords.js';
import './css-integer-properties.js';
import CSSPropertyManager from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/CSSPropertyManager.ts';
import CSSTextParser from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/utilities/CSSTextParser.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';
import {borderLonghands,expandBorderValue} from '../style/border-values.js';
import {backgroundLonghands,expandBackgroundValue,serializeBackground} from '../style/background-values.js';
import {marginLonghands,expandMargin,compressMargin} from '../style/margin-values.js';
import {paddingLonghands,expandPadding} from '../style/padding-values.js';
import {insetLonghands,expandInset} from '../style/inset-values.js';
import {gapProperty,gapLonghands,expandGap} from '../style/gap-values.js';
import {alignmentLonghands,expandAlignment,serializeAlignment} from '../style/alignment-values.js';
import {parseCSSComponentValues} from '../style/css-value-tokens.js';
import {parseDeclarationText} from './css-text-parser.js';
import {isCSSOMPublishedManager} from './css-declaration-mutations.js';

const parse=CSSTextParser.parse,set=CSSPropertyManager.prototype.set,get=CSSPropertyManager.prototype.get;
const toString=CSSPropertyManager.prototype.toString,remove=CSSPropertyManager.prototype.remove;
const wide=new Set(['initial','inherit','unset','revert','revert-layer']);
const pending=manager=>Object.values(manager.properties).some(property=>property.pendingBorder);
const orderStates=new WeakMap();
// One declaration-order/provenance domain for pending shorthands. The older
// pendingBorder field is internal; its value names either source family.
const longhands=name=>alignmentLonghands(name)??gapLonghands(name)??insetLonghands(name)??paddingLonghands(name)??marginLonghands(name)??backgroundLonghands(name)??borderLonghands(name);
const expand=(name,value,allowPending=true)=>alignmentLonghands(name)?expandAlignment(name,value,allowPending):gapLonghands(name)?expandGap(name,value,allowPending):insetLonghands(name)?expandInset(name,value,allowPending):marginLonghands(name)?expandMargin(name,value,allowPending):
  paddingLonghands(name)?expandPadding(name,value,allowPending):
  backgroundLonghands(name.toLowerCase())?expandBackgroundValue(name,value,allowPending):expandBorderValue(name,value,allowPending);

CSSTextParser.parse=function(input) {
  const result=parse(input);
  const expanded=result.rules.flatMap(rule=>{
    const values=expand(rule.name,rule.value);
    return values===undefined?[rule]:values===null?[]:values.map(value=>({...rule,...value,
      value:value.pendingBorder?{borderSource:value.value,pendingBorder:value.pendingBorder}:value.value}));
  });
  // Resolve shorthand priority per physical longhand before the vendor's
  // constructor. Keep the winner at its actual source position across all.
  const winners=new Map();
  for(const rule of expanded)if(longhands(rule.name)?.length===1||rule.name.startsWith('border-image-'))
    if(rule.important||!winners.get(rule.name)?.important)winners.set(rule.name,rule);
  result.rules=expanded.filter(rule=>!winners.has(rule.name)||winners.get(rule.name)===rule);
  return result;
};

CSSPropertyManager.prototype.set=function(name,value,important) {
  name=gapProperty(name);
  let state=orderStates.get(this);
  if(!state) {
    state={next:Object.values(this.properties).reduce((next,p)=>Math.max(next,p.declarationOrder??0),0),depth:0};
    orderStates.set(this,state);
  }
  const outer=state.depth++===0,order=outer?++state.next:state.next;
  let keys=[];
  try {
    if(value&&typeof value==='object'&&typeof value.borderSource==='string') {
      keys=set.call(this,name,'initial',important);
      this.properties[name]={value:'',important,pendingBorder:value.pendingBorder,borderSource:value.borderSource};
    } else {
      const values=value===null?undefined:expand(name,value);
      if(values===null)return [];
      if(values===undefined)keys=set.call(this,name,value,important);
      else for(const part of values) {
        keys.push(...set.call(this,part.name,part.pendingBorder?'initial':part.value,important));
        if(part.pendingBorder)this.properties[part.name]={value:'',important,pendingBorder:part.pendingBorder,borderSource:part.value};
      }
    }
    // A single order domain covers border, overflow and ordinary declarations.
    // Cloning the vendor's property records retains this metadata; weak state
    // belongs to the manager and does not keep any document alive.
    if(outer)for(const key of keys)if(this.properties[key])this.properties[key].declarationOrder=order;
    return keys;
  } finally {state.depth--;}
};

CSSPropertyManager.prototype.get=function(name) {
  name=gapProperty(name);
  const names=longhands(name);
  if(!names||names.length===1)return get.call(this,name);
  const parts=names.map(name=>this.properties[name]);
  if(parts.some(part=>!part)||parts.some(part=>Boolean(part.important)!==Boolean(parts[0].important)))return null;
  if(parts.some(part=>part.pendingBorder))return parts.every(part=>part.pendingBorder===name&&part.borderSource===parts[0].borderSource)
    ?{value:parts[0].borderSource,important:parts[0].important}:null;
  const physical=parts.filter((_,index)=>!names[index].startsWith('border-image-'));
  if(physical.some(part=>wide.has(part.value)))return parts.every(part=>part.value===parts[0].value)
    ?{value:parts[0].value,important:parts[0].important}:null;
  if(alignmentLonghands(name)) {
    // Equal var() sources on separate longhands are not a pending shorthand:
    // substitution must validate each longhand independently on a round trip.
    if(parts.some(part=>parseCSSComponentValues(part.value)?.pending))return null;
    return {value:serializeAlignment(...parts.map(part=>part.value)),important:parts[0].important};
  }
  if(gapLonghands(name)||marginLonghands(name)||paddingLonghands(name)||insetLonghands(name))return {value:compressMargin(parts.map(part=>part.value)),important:parts[0].important};
  if(backgroundLonghands(name))return serializeBackground(this.properties,name);
  // border resets border-image. Serializing it over a non-initial image would
  // silently discard that image on a cssText round trip.
  if(name==='border') {
    const defaults={source:'none',slice:'100%',width:'1',outset:'0',repeat:'stretch'};
    if(Object.entries(defaults).some(([part,value])=>!['initial',value].includes(this.properties[`border-image-${part}`]?.value)))return null;
  }
  return get.call(this,name);
};

CSSPropertyManager.prototype.remove=function(name) {
  name=gapProperty(name);
  if(/^border-(top|right|bottom|left)$/.test(name)||alignmentLonghands(name)?.length>1||gapLonghands(name)?.length>1||marginLonghands(name)?.length>1||paddingLonghands(name)?.length>1||insetLonghands(name)?.length>1) {
    for(const longhand of longhands(name))remove.call(this,longhand);
    return;
  }
  return remove.call(this,name);
};

function declarations(manager) {
  return Object.entries(manager.properties).map(([name,property],index)=>({name,property,index}))
    .sort((a,b)=>(a.property.declarationOrder??a.index)-(b.property.declarationOrder??b.index)||a.index-b.index);
}
const ordinaryGroups=new Map();
function groupNames(manager,name) {
  const border=longhands(name);if(border)return border;
  if(name==='overflow')return ['overflow-x','overflow-y'];
  if(Object.hasOwn(manager.properties,name))return [name];
  if(!['margin','padding','font','background','border-image'].includes(name))return [];
  if(!ordinaryGroups.has(name)) {
    // The existing vendor owns its other shorthand expansion/reset lists.
    // Derive those lists once; do not duplicate background/font grammar here.
    const probe=new CSSPropertyManager();set.call(probe,name,'initial',false);
    ordinaryGroups.set(name,Object.keys(probe.properties));
  }
  return ordinaryGroups.get(name);
}
function serialize(manager,entries) {
  const emitted=new Set(),rules=[];
  const originals=parseDeclarationText(toString.call(manager)).rules;
  const groups=[...new Set(['place-content','place-items','place-self','gap','inset','inset-block','inset-inline','margin','margin-block','margin-inline','padding','padding-block','padding-inline','background','background-position','border','border-top','border-right','border-bottom','border-left','border-width','border-style','border-color','overflow',...originals.map(rule=>rule.name)])]
    .map(name=>({name,names:groupNames(manager,name),value:manager.get(name)}))
    .filter(group=>group.names.length>1&&group.value);
  for(let index=0;index<entries.length;index++) {
    const {name,property}=entries[index];
    if(emitted.has(name))continue;
    // A shorthand may only replace a contiguous run. Moving declarations
    // across all or a logical alias would change the result of cssText reuse.
    const group=groups.find(group=>group.names.includes(name)&&group.names.every(name=>!emitted.has(name))&&
      entries.slice(index,index+group.names.length).length===group.names.length&&
      entries.slice(index,index+group.names.length).every(entry=>group.names.includes(entry.name)));
    if(group) {
      for(const name of group.names)emitted.add(name);
      rules.push({name:group.name,value:group.value.value,important:group.value.important});
    } else rules.push({name,value:property.value,important:property.important});
  }
  return rules.map(rule=>`${rule.name}: ${rule.value}${rule.important?' !important':''};`).join(' ');
}
// Keep only the latest serialization per manager. Check the actual records,
// rather than invalidating only in set(): shorthand adapters and cloned
// managers also edit records directly. Absolute declarationOrder counters may
// change on an identical assignment; the sorted order is what serialization
// consumes. Pending sources and the vendor's insertion order matter as well.
const serializedManagers=new WeakMap();
const serializationFields=['value','important','pendingBorder','borderSource','overflowSource'];
function sameSerialization(cached,entries,defined) {
  if(!cached||cached.entries.length!==entries.length||cached.defined.length!==defined.length)return false;
  for(let i=0;i<defined.length;i++)if(cached.defined[i]!==defined[i])return false;
  for(let i=0;i<entries.length;i++) {
    const entry=entries[i],old=cached.entries[i];
    if(entry.name!==old.name||entry.index!==old.index)return false;
    for(const field of serializationFields)if(entry.property[field]!==old[field])return false;
  }
  return true;
}
CSSPropertyManager.prototype.toString=function() {
  // Preserve the established serializer for declarations outside these families.
  if(!Object.keys(this.properties).some(name=>longhands(name)))return toString.call(this);
  const entries=declarations(this),defined=Object.keys(this.definedPropertyNames),cached=serializedManagers.get(this);
  if(sameSerialization(cached,entries,defined))return cached.text;
  const text=serialize(this,entries);
  serializedManagers.set(this,{text,defined,entries:entries.map(({name,index,property})=>({name,index,
    ...Object.fromEntries(serializationFields.map(field=>[field,property[field]]))}))});
  return text;
};

// One complete snapshot, not independent border/overflow index spaces. It is
// internal data only: pending longhand getters still expose the empty string.
export function pendingBorderDeclarations(style) {
  const cache=style?.[S.cache],element=style?.[S.element],manager=cache?.propertyManager;
  if(!manager||!isCSSOMPublishedManager(manager)||element&&cache.attributeValue!==(element.getAttributeNS(null,'style')??'')||!pending(manager))return null;
  return declarations(manager).map(({name,property},declarationIndex)=>({name,
    value:property.borderSource??property.overflowSource??property.value,
    important:Boolean(property.important),pendingBorder:property.pendingBorder,
    pendingOverflow:Boolean(property.overflowSource),declarationIndex}));
}
export function inlinePendingBorder(element) {return pendingBorderDeclarations(element?.[S.style]);}
export function restoreBorderDeclarations(map,snapshot) {return snapshot?new Map(snapshot.map(declaration=>[declaration.name,{...declaration}])):map;}
const sheetSnapshots=new WeakMap();
export function borderSheetSource(text,snapshots) {
  if(!snapshots.size)return text;
  const source=typeof text==='object'?text:Object.freeze({toString:()=>text});
  sheetSnapshots.set(source,snapshots);return source;
}
export function borderSheetSnapshots(source) {return typeof source==='object'&&source!==null?sheetSnapshots.get(source):undefined;}
