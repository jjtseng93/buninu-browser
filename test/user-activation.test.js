import {test,expect} from 'bun:test';
import {createUserActivation} from '../lib/renderer/user-activation.js';

function frame(origin,parent=null){const kids=[];const f={origin:()=>origin,parent:()=>parent,top:()=>parent?parent.top():f,children:()=>kids,closed:()=>false,kids};parent?.kids.push(f);return f;}
test('activation expires after five seconds, remains sticky and does not need timers',()=>{
 let t=100;const a=createUserActivation({now:()=>t});expect([a.hasBeenActive,a.isActive]).toEqual([false,false]);
 a.notify({type:'mousemove'});a.notify({type:'keydown',key:'Escape'});expect(a.hasBeenActive).toBe(false);
 a.notify({type:'keydown',key:'a'});expect([a.hasBeenActive,a.isActive]).toEqual([true,true]);
 t=5099;expect(a.isActive).toBe(true);t=5100;expect([a.hasBeenActive,a.isActive]).toEqual([true,false]);
 a.notify({type:'mousedown'});expect(a.consume()).toBe(true);expect(a.consume()).toBe(false);expect(a.hasBeenActive).toBe(true);
});
test('mouse pointer-down and non-mouse pointer-up activate, moves and mouse up do not',()=>{
 for(const [type,pointerType,want]of [['pointerdown','mouse',true],['pointerdown','touch',false],['pointerup','touch',true],['pointerup','pen',true],['pointerup','mouse',false],['pointermove','touch',false],['touchend',undefined,true]]){
  const a=createUserActivation({now:()=>1});a.notify({type,pointerType});expect(a.hasBeenActive).toBe(want);
 }
});
test('activation reaches ancestors and same-origin siblings, consumption clears whole tree',()=>{
 const root=frame('https://a.test'),a=frame('https://b.test',root),same=frame('https://b.test',root),other=frame('https://c.test',root),child=frame('https://b.test',a);
 const states=[root,a,same,other,child].map(self=>createUserActivation({self,now:()=>100}));
 states[1].notify({type:'mousedown'});expect(states.map(a=>a.hasBeenActive)).toEqual([true,true,true,false,true]);
 expect(states[3].consume()).toBe(false);expect(states[1].isActive).toBe(true);
 states[3].notify({type:'mousedown'});expect(states[1].consume()).toBe(true);expect(states.map(a=>a.isActive)).toEqual([false,false,false,false,false]);
});
test('opaque sibling origins are distinct; old document disposal cannot detach its replacement',()=>{
 const root=frame('https://a.test'),a=frame('null',root),b=frame('null',root);
 const parent=createUserActivation({self:root,now:()=>1}),first=createUserActivation({self:a,now:()=>1}),second=createUserActivation({self:b,now:()=>1});
 first.notify({type:'mousedown'});expect([parent.hasBeenActive,first.hasBeenActive,second.hasBeenActive]).toEqual([true,true,false]);
 const replacement=createUserActivation({self:a,now:()=>1});first.dispose();replacement.notify({type:'mousedown'});expect(replacement.hasBeenActive).toBe(true);
 const sibling=createUserActivation({self:frame('https://a.test',root),now:()=>1});parent.notify({type:'keydown',key:'a'});expect(sibling.hasBeenActive).toBe(true);
});

test('modifier-only keys do not activate and disposal clears transient state',()=>{
 const a=createUserActivation({now:()=>0});
 for(const key of ['Shift','Control','Alt','AltGraph','Meta','CapsLock']) a.notify({type:'keydown',key});
 expect(a.hasBeenActive).toBe(false);
 a.notify({type:'keydown',key:'x'});expect(a.isActive).toBe(true);
 a.dispose();expect(a.isActive).toBe(false);
 a.notify({type:'mousedown'});expect(a.isActive).toBe(false);
});
