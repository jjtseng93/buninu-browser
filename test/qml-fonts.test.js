import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,copyFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadGraphics} from '../lib/renderer/page-renderer.js';
import {qmlFontFiles,loadQmlFonts} from '../lib/qml/fonts.js';

test('Qt font directory: recursive, symlink-safe, cached, isolated and invalid-font tolerant',async()=>{
 const root=await mkdtemp(join(tmpdir(),'qml-fonts-'));
 try {
  await mkdir(join(root,'nested'));
  await copyFile(new URL('../usr/share/fonts/DejaVuSansMono.ttf',import.meta.url),join(root,'nested','Regular.ttf'));
  await symlink(root,join(root,'nested','cycle'));
  await symlink(join(root,'nested','Regular.ttf'),join(root,'duplicate.ttf'));
  await Bun.write(join(root,'invalid.otf'),'not a font');
  await Bun.write(join(root,'ignored.txt'),'ignore');
  expect((await qmlFontFiles(root)).length).toBe(2);
  const base=await loadGraphics(),families=[...base.fontFamilies],warn=[];
  const qml=await loadQmlFonts(base,m=>warn.push(m),root);
  expect(qml).not.toBe(base);
  expect(qml.fontFamilies.length).toBe(families.length+1);
  expect(base.fontFamilies).toEqual(families);
  const face=qml.builtinTypefaces.at(-1);
  expect(face.typeface.getGlyphIDs('A')[0]).toBeGreaterThan(0);
  expect(face.typeface.getGlyphIDs('\u{f040a}')[0]).toBe(0);
  expect(warn.length).toBe(1);
  expect(await loadQmlFonts(base,()=>{},root)).toBe(qml);
  expect(await loadQmlFonts(base,()=>{},'')).toBe(base);
  expect(await loadQmlFonts(base,()=>{},join(root,'missing'))).toBe(base);
 }finally{await rm(root,{recursive:true,force:true});}
});
