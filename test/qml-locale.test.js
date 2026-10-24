import {test,expect} from 'bun:test';
import {createQt} from '../lib/qml/builtins.js';

test('C/POSIX locale is metric and uses Qt date order and 24-hour time',()=>{
 for(const name of ['C','C.UTF-8','POSIX']) {
  const qt=createQt({LC_ALL:name,LANG:'en_US.UTF-8',LC_TIME:'en_US.UTF-8',LC_MEASUREMENT:'en_US.UTF-8'});
  const l=qt.locale();
  expect(l.name).toBe('C');expect(l.measurementSystem).toBe(0);
  expect(l.dateFormat(1)).toBe('d MM yyyy');expect(l.timeFormat(1)).toBe('HH:mm');
  expect(qt.locale('en_US.UTF-8').measurementSystem).toBe(1);
 }
});
test('locale categories override LANG but explicit locale ignores environment',()=>{
 const qt=createQt({LANG:'en_US.UTF-8',LC_TIME:'en_GB.UTF-8',LC_MEASUREMENT:'zh_TW.UTF-8'});
 expect(qt.locale().name).toBe('en_US');expect(qt.locale().measurementSystem).toBe(0);
 expect(qt.locale().timeFormat(1)).not.toContain('AP');
 expect(qt.locale().dateFormat(1).indexOf('d')).toBeLessThan(qt.locale().dateFormat(1).indexOf('M'));
 expect(qt.locale('en_US').timeFormat(1)).toContain('AP');
 expect(qt.locale('en_GB').measurementSystem).toBe(2);
 expect(qt.locale('C').timeFormat(1)).toBe('HH:mm');
 expect(qt.locale('not_a_valid_locale').name).toBe('C');
});
test('empty overrides inherit LANG; unset system defaults to C',()=>{
 const qt=createQt({LC_ALL:'',LC_TIME:'',LANG:'zh_TW.UTF-8'});
 expect(qt.locale().name).toBe('zh_TW');expect(qt.locale().measurementSystem).toBe(0);
 expect(qt.locale().dateFormat(1).indexOf('y')).toBeLessThan(qt.locale().dateFormat(1).indexOf('M'));
 expect(createQt({}).locale().name).toBe('C');
 const d=new Date(2024,10,23,17,45,36);
 expect(createQt({LANG:'C.UTF-8'}).formatTime(d,'HH:mm')).toBe('17:45');
 expect(createQt({LANG:'C.UTF-8'}).formatDate(d,'MMMM')).toBe('November');
});

test('local QML host receives locale categories through its host capability',async()=>{
 for(const [env,expected] of [
  [{LC_ALL:'C.UTF-8',LANG:'en_US.UTF-8'},{name:'C',measurement:0,date:'d MM yyyy',time:'HH:mm'}],
  [{LC_ALL:'',LANG:'en_US.UTF-8',LC_MESSAGES:'',LC_TIME:'en_GB.UTF-8',LC_MEASUREMENT:'zh_TW.UTF-8'},null],
 ]) {
  const child=Bun.spawn([process.execPath,new URL('./fixtures/qml-locale/check.mjs',import.meta.url).pathname],{env:{...process.env,...env},stdout:'pipe',stderr:'pipe'});
  const [output,error,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect({code,error}).toEqual({code:0,error:''});
  const result=JSON.parse(output.trim());
  if(expected)expect(result).toEqual(expected);
  else {expect(result.name).toBe('en_US');expect(result.measurement).toBe(0);expect(result.time).toBe('HH:mm');}
 }
},15000);
