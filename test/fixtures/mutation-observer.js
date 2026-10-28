import assert from 'node:assert/strict';
import { createPageRenderer } from '../../lib/renderer/page-renderer.js';

async function mutationObserverCases() {
  const results = {};
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const describe = records => records.map(r => [r.type, r.target.id, r.attributeName, r.oldValue,
    Array.from(r.addedNodes, n => n.id || n.nodeName), Array.from(r.removedNodes, n => n.id || n.nodeName)]);
  async function run(name, fn) {
    const root = document.createElement('div');root.id='root';
    root.innerHTML='<div id="a"><span id="child"></span></div><div id="b"></div>';
    document.body.appendChild(root);
    const observers=[];
    const make = callback => {const o=new MutationObserver(callback);observers.push(o);return o;};
    try { results[name]=await fn(root,make); }
    finally {for(const observer of observers)observer.disconnect();root.remove();await tick();}
  }
  await run('multipleTargets',async(root,make)=>{
    const [a,b]=root.children,batches=[];const o=make(r=>batches.push(describe(r)));
    o.observe(a,{attributes:true});o.observe(b,{attributes:true});
    b.setAttribute('x','1');a.setAttribute('y','2');b.setAttribute('z','3');await tick();return batches;
  });
  await run('takeRecords',async(root,make)=>{
    const [a,b]=root.children,batches=[];const o=make(r=>batches.push(describe(r)));
    o.observe(a,{attributes:true});o.observe(b,{attributes:true});
    b.setAttribute('x','1');a.setAttribute('y','2');b.setAttribute('z','3');
    const records=describe(o.takeRecords());await tick();return {records,batches,empty:o.takeRecords().length};
  });
  await run('overlappingTargets',async(root,make)=>{
    const child=root.querySelector('#child'),batches=[];child.setAttribute('value','old');
    const o=make(r=>batches.push(describe(r)));
    o.observe(root,{subtree:true,attributes:true,attributeOldValue:true});o.observe(child,{attributes:true});
    child.setAttribute('value','new');await tick();return batches;
  });
  await run('creationAndPromiseOrder',async(root,make)=>{
    const [a,b]=root.children,events=[];
    const older=make(()=>events.push('older')),newer=make(()=>events.push('newer'));
    newer.observe(b,{attributes:true});older.observe(a,{attributes:true});
    b.setAttribute('x','1');Promise.resolve().then(()=>events.push('promise'));a.setAttribute('x','1');
    await tick();return events;
  });
  await run('callbackMutation',async(root,make)=>{
    const [a,b]=root.children,events=[];let calls=0;
    const o=make(r=>{events.push(describe(r));if(++calls===1){a.setAttribute('second','a');b.setAttribute('second','b');}});
    o.observe(a,{attributes:true});o.observe(b,{attributes:true});
    a.setAttribute('first','1');Promise.resolve().then(()=>events.push('promise'));
    await tick();return events;
  });
  await run('callbackMutatesLaterObserver',async(root,make)=>{
    const [a,b]=root.children,events=[];
    const first=make(r=>{events.push(['first',describe(r)]);b.setAttribute('later','2');});
    const second=make(r=>events.push(['second',describe(r)]));
    first.observe(a,{attributes:true});second.observe(b,{attributes:true});
    b.setAttribute('initial','1');a.setAttribute('initial','1');await tick();return events;
  });
  await run('disconnectReobserve',async(root,make)=>{
    const [a,b]=root.children,batches=[];const o=make(r=>batches.push(describe(r)));
    o.observe(a,{attributes:true});a.setAttribute('discard','1');o.disconnect();
    o.observe(b,{attributes:true});b.setAttribute('keep','2');await tick();return batches;
  });
  await run('drainOtherObserver',async(root,make)=>{
    const [a,b]=root.children,events=[];let second;
    const first=make(()=>events.push(['drained',describe(second.takeRecords())]));
    second=make(r=>events.push(['second',describe(r)]));
    first.observe(a,{attributes:true});second.observe(b,{attributes:true});
    b.setAttribute('x','1');a.setAttribute('x','1');await tick();return events;
  });
  await run('reobserveOptions',async(root,make)=>{
    const a=root.firstElementChild,batches=[];const o=make(r=>batches.push(describe(r)));
    o.observe(a,{attributes:true,attributeFilter:['x']});a.setAttribute('x','first');
    o.observe(a,{attributes:true,attributeFilter:['y']});a.setAttribute('x','ignored');a.setAttribute('y','kept');
    await tick();return batches;
  });
  for(const childList of [false,true])await run('detachedSubtree'+childList,async(root,make)=>{
    const a=root.firstElementChild,child=a.firstElementChild,batches=[];
    const o=make(r=>batches.push(describe(r)));o.observe(root,{subtree:true,childList,attributes:true});
    a.remove();child.setAttribute('before','1');await tick();child.setAttribute('after','2');await tick();return batches;
  });
  await run('moveAndEmpty',async(root,make)=>{
    const [a,b]=root.children,child=a.firstElementChild,batches=[];
    const o=make(r=>batches.push(describe(r)));o.observe(root,{subtree:true,childList:true,attributes:true});
    a.remove();a.removeChild(child);b.appendChild(child);child.setAttribute('before','1');
    await tick();child.setAttribute('after','2');await tick();return batches;
  });
  await run('detachedTarget',async(root,make)=>{
    const a=root.firstElementChild,batches=[];a.remove();
    const o=make(r=>batches.push(describe(r)));o.observe(a,{attributes:true});a.setAttribute('x','1');await tick();return batches;
  });
  await run('exceptionIsolation',async(root,make)=>{
    const [a,b]=root.children,events=[];
    const handler=e=>e.preventDefault();window.addEventListener('error',handler);
    const first=make(()=>{events.push('first');throw new Error('observer-fixture-expected');});
    const second=make(()=>events.push('second'));first.observe(a,{attributes:true});second.observe(b,{attributes:true});
    a.setAttribute('x','1');b.setAttribute('x','1');await tick();window.removeEventListener('error',handler);return events;
  });
  await run('omittedAttributeOptions',async(root,make)=>{
    const a=root.firstElementChild,events=[];
    const o=make(r=>events.push(describe(r)));o.observe(a,{attributeOldValue:false});
    a.setAttribute('x','first');a.setAttribute('x','second');await tick();return events;
  });
  await run('omittedCharacterOptions',async(root,make)=>{
    const a=root.firstElementChild,text=document.createTextNode('old'),events=[];a.appendChild(text);
    const o=make(r=>events.push(r.map(x=>[x.type,x.oldValue])));o.observe(text,{characterDataOldValue:false});
    text.data='new';await tick();return events;
  });
  await run('invalidCallback',async()=>[null,undefined,{},1,'x'].map(value=>{
    try {new MutationObserver(value);return false;} catch(error){return error.name;}
  }));
  await run('filterCase',async(root,make)=>{
    const a=root.firstElementChild,events=[];const o=make(r=>events.push(describe(r)));
    o.observe(a,{attributes:true,attributeFilter:['UPPER']});a.setAttribute('UPPER','1');
    await tick();return events;
  });
  await run('reobserveSubtree',async(root,make)=>{
    const a=root.firstElementChild,child=a.firstElementChild,events=[];const o=make(r=>events.push(describe(r)));
    o.observe(root,{attributes:true,subtree:true});a.remove();
    o.observe(root,{attributes:true,subtree:false});child.setAttribute('ignored','1');root.setAttribute('yes','1');
    root.appendChild(a);child.setAttribute('also-ignored','1');await tick();
    o.observe(root,{attributes:true,subtree:true});child.setAttribute('kept','1');await tick();return events;
  });
  await run('transientDuringCallback',async(root,make)=>{
    const a=root.firstElementChild,child=a.firstElementChild,events=[];
    const o=make(r=>{events.push(describe(r));child.setAttribute('callback','ignored');});
    o.observe(root,{attributes:true,subtree:true,childList:true});a.remove();await tick();return events;
  });
  await run('takeRecordsKeepsTransient',async(root,make)=>{
    const a=root.firstElementChild,child=a.firstElementChild,events=[];const o=make(r=>events.push(describe(r)));
    o.observe(root,{attributes:true,subtree:true,childList:true});a.remove();const drained=describe(o.takeRecords());
    child.setAttribute('before','yes');await tick();child.setAttribute('after','ignored');await tick();return {drained,events};
  });
  await run('optionValidation',async(root,make)=>{
    const a=root.firstElementChild,callable=function(){};
    callable[Symbol.iterator]=function*(){yield 'x'};
    const options=[{}, {attributes:false,attributeOldValue:false},
      {childList:true,attributes:false,attributeFilter:[]}, {characterData:false,characterDataOldValue:true},
      {attributeFilter:[]}, {attributeFilter:new Set(['x'])}, {attributeFilter:callable},
      {attributeFilter:'x'}, {attributeFilter:{length:1,0:'x'}}, {attributeFilter:null},
      {attributeOldValue:undefined}, {characterDataOldValue:undefined},
      {childList:true,attributes:false,attributeOldValue:false}, {attributeFilter:[Symbol('x')]}];
    return options.map((option,i)=>{const observer=make(()=>{});try{
      observer.observe(a,option);a.setAttribute('x',String(i));const records=observer.takeRecords();
      observer.disconnect();return ['ok',records.map(record=>record.attributeName)];
    }catch(error){return error.name;}});
  });
  await run('optionConversionOrder',async(root,make)=>{
    const events=[],options={},filter={get [Symbol.iterator](){events.push('iterator');return function*(){
      events.push('first');yield {toString(){events.push('string');return 'x'}};events.push('end');
    }}};
    for(const key of ['attributeFilter','attributeOldValue','attributes','characterData','characterDataOldValue','childList','subtree']){
      Object.defineProperty(options,key,{get(){events.push(key);return key==='attributeFilter'?filter:undefined}});
    }
    make(()=>{}).observe(root,options);return events;
  });
  return results;
}

const expected = {
  "multipleTargets": [[["attributes","b","x",null,[],[]],["attributes","a","y",null,[],[]],["attributes","b","z",null,[],[]]]],
  "takeRecords": {"records":[["attributes","b","x",null,[],[]],["attributes","a","y",null,[],[]],["attributes","b","z",null,[],[]]],"batches":[],"empty":0},
  "overlappingTargets": [[["attributes","child","value","old",[],[]]]],
  "creationAndPromiseOrder": ["older","newer","promise"],
  "callbackMutation": [[["attributes","a","first",null,[],[]]],"promise",[["attributes","a","second",null,[],[]],["attributes","b","second",null,[],[]]]],
  "callbackMutatesLaterObserver": [["first",[["attributes","a","initial",null,[],[]]]],["second",[["attributes","b","initial",null,[],[]],["attributes","b","later",null,[],[]]]]],
  "disconnectReobserve": [[["attributes","b","keep",null,[],[]]]],
  "drainOtherObserver": [["drained",[["attributes","b","x",null,[],[]]]]],
  "reobserveOptions": [[["attributes","a","x",null,[],[]],["attributes","a","y",null,[],[]]]],
  "detachedSubtreefalse": [[["attributes","child","before",null,[],[]]]],
  "detachedSubtreetrue": [[["childList","root",null,null,[],["a"]],["attributes","child","before",null,[],[]]]],
  "moveAndEmpty": [[["childList","root",null,null,[],["a"]],["childList","a",null,null,[],["child"]],["childList","b",null,null,["child"],[]],["attributes","child","before",null,[],[]]],[["attributes","child","after",null,[],[]]]],
  "detachedTarget": [[["attributes","a","x",null,[],[]]]],
  "exceptionIsolation": ["first","second"],
  "omittedAttributeOptions": [[["attributes","a","x",null,[],[]],["attributes","a","x",null,[],[]]]],
  "omittedCharacterOptions": [[["characterData",null]]],
  "invalidCallback": ["TypeError","TypeError","TypeError","TypeError","TypeError"],
  "filterCase": [],
  "reobserveSubtree": [[["attributes","root","yes",null,[],[]]],[["attributes","child","kept",null,[],[]]]],
  "transientDuringCallback": [[["childList","root",null,null,[],["a"]]]],
  "takeRecordsKeepsTransient": {"drained":[["childList","root",null,null,[],["a"]]],"events":[[["attributes","child","before",null,[],[]]]]},
  "optionValidation": ["TypeError","TypeError","TypeError","TypeError",["ok",[]],["ok",["x"]],["ok",["x"]],"TypeError","TypeError","TypeError","TypeError","TypeError",["ok",[]],"TypeError"],
  "optionConversionOrder": ["attributeFilter","iterator","first","string","end","attributeOldValue","attributes","characterData","characterDataOldValue","childList","subtree"]
};

const errors=[];
const renderer=await createPageRenderer({reportError:error=>errors.push(String(error))});
await import('../../vendor/ses/dist/ses.mjs');
lockdown({errorTaming:'safe',overrideTaming:'severe',consoleTaming:'unsafe',localeTaming:'unsafe',stackFiltering:'concise',reporting:'none'});
try {
  renderer.setScripting('ses'); renderer.resize(400,300,1);
  await renderer.loadDocument({url:'https://mutation.test/',contentType:'text/html',source:'<!doctype html><body></body>'});
  await renderer.whenLoaded();
  const result=JSON.parse(await renderer.evaluate('('+mutationObserverCases.toString()+')().then(JSON.stringify)'));
  for (const [name,value] of Object.entries(expected)) assert.deepEqual(result[name],value,name);
  assert.equal(errors.length,1); assert.match(errors[0],/observer-fixture-expected/);
  // Navigation gives the next realm a fresh observer constructor and delivery.
  await renderer.loadDocument({url:'https://mutation.test/next',contentType:'text/html',source:'<!doctype html><body></body>'});
  await renderer.whenLoaded();
  assert.equal(await renderer.evaluate(`new Promise(resolve=>{
    const observer=new MutationObserver(records=>{observer.disconnect();resolve(records.length)});
    observer.observe(document.body,{attributes:true});document.body.setAttribute('next','1');
  })`),1);
} finally { renderer.dispose(); }
