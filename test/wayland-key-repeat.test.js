import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,openSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {attachInput} from '../frontends/wayland/input.js';

function fixture(press){
 const dir=mkdtempSync(join(tmpdir(),'wayland-repeat-')),file=join(dir,'keymap');
 const text='<LEFT> = 113; <SHIFT> = 50; <NOREPEAT> = 38; key <LEFT> { [ Left, Left ] }; key <SHIFT> { [ Shift_L ] }; key <NOREPEAT> { repeat=no, [ a, A ] };';
 writeFileSync(file,text);let capabilities,keyboard;
 const calls=[],client={globals:new Map([['wl_seat',{}]]),connection:{closed:false},bind(_i,_v,fn){capabilities=fn;return 2;},object(iface,fn){if(iface==='wl_keyboard')keyboard=fn;return 3;},request(){}};
 const window={surface:4,closed:false};
 const stop=attachInput(client,window,{press:async(...args)=>{calls.push(args);await press?.(...args);}},error=>{throw error;});
 capabilities('capabilities',[2]);
 keyboard('keymap',[1,openSync(file,'r'),Buffer.byteLength(text)]);
 keyboard('repeat_info',[100,20]);keyboard('enter',[1,4,Buffer.alloc(0)]);
 return {calls,window,client,key:(code,state)=>keyboard('key',[2,0,code,state]),event:(...a)=>keyboard(...a),
  close(){stop();rmSync(dir,{recursive:true,force:true});}};
}
const until=async fn=>{for(let i=0;i<100;i++){if(fn())return;await Bun.sleep(5);}throw Error('Repeat did not arrive');};

test('Wayland repeat_info drives held arrows, updates modifiers, and stops on key release',async()=>{
 const f=fixture();try{
  f.key(105,1);await until(()=>f.calls.length>=3);
  expect(f.calls[0]).toEqual(['ArrowLeft',{modifiers:0}]);
  expect(f.calls[1][1].repeat).toBe(true);
  f.key(42,1);f.event('modifiers',[3,1,0,0]);
  await until(()=>f.calls.some(c=>c[1].modifiers===8));
  f.key(105,0);await Bun.sleep(0);const n=f.calls.length;
  await Bun.sleep(50);expect(f.calls.length).toBe(n);
 }finally{f.close();}
});

test('disabled repeat, keymap flags, focus loss and disposal never leave repeat timers running',async()=>{
 const f=fixture();try{
  f.event('repeat_info',[0,20]);f.key(105,1);await Bun.sleep(60);expect(f.calls.length).toBe(1);
  f.key(105,0);f.event('repeat_info',[100,20]);f.key(30,1);
  await Bun.sleep(60);expect(f.calls.length).toBe(2);
  f.key(105,1);await until(()=>f.calls.length>=4);
  f.event('leave',[4,4]);await Bun.sleep(0);const n=f.calls.length;
  await Bun.sleep(50);expect(f.calls.length).toBe(n);
  f.event('enter',[5,4,Buffer.alloc(0)]);f.key(105,1);
  f.close();await Bun.sleep(50);expect(f.calls.length).toBe(n);
 }finally{f.close();}
});

test('a slow repeat press cannot accumulate a queue, and closing cancels future presses',async()=>{
 let release;const f=fixture((_key,options)=>options.repeat?new Promise(r=>release=r):undefined);
 try{
  f.key(105,1);await until(()=>Boolean(release));
  await Bun.sleep(60);expect(f.calls.length).toBe(2);
  f.window.closed=true;release();await Bun.sleep(50);expect(f.calls.length).toBe(2);
 }finally{release?.();f.close();}
});
