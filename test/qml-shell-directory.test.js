import {test,expect} from 'bun:test';
import {qmlShellDirectory} from '../lib/qml/host.js';
test('QML shellDir normalizes Windows separators and preserves filesystem roots',()=>{
 expect(qmlShellDirectory('file:///C:/ui/boot/','win32')).toBe('C:/ui/boot');
 expect(qmlShellDirectory('file:///C:/','win32')).toBe('C:/');
 expect(qmlShellDirectory('file://server/share/boot/','win32')).toBe('//server/share/boot');
 expect(qmlShellDirectory('file:///home/a%5Cb/','linux')).toBe('/home/a\\b');
 expect(qmlShellDirectory('file:///','linux')).toBe('/');
});
