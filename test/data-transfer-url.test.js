import {expect,test} from 'bun:test';
import {DataTransfer,setDragMode} from '../lib/renderer/html-drag.js';
test('URL alias returns first URI without altering the stored list',()=>{
 const d=new DataTransfer(),list='# comment\r\n\r\nhttps://a.example/\r\nhttps://b.example/';
 d.setData('text/uri-list',list);
 expect(d.getData(' URL ')).toBe('https://a.example/');
 expect(d.getData('text/uri-list')).toBe(list);
 d.setData('TEXT/plain;charset=UTF-8','hello');
 expect(d.getData(' text ')).toBe('hello');
 expect(d.types).toEqual(['text/uri-list','text/plain']);
 setDragMode(d,'protected');expect(d.getData('url')).toBe('');
 setDragMode(d,'readonly');expect(d.getData('url')).toBe('https://a.example/');
 d.setData('url','changed');expect(d.getData('url')).toBe('https://a.example/');
 setDragMode(d,'readwrite');d.clearData(' URL ');expect(d.getData('url')).toBe('');
 d.setData('url','# no URL\n\n');expect(d.getData('url')).toBe('');
});
