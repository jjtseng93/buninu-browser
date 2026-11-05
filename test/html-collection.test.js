import {test,expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {htmlCollectionInterface} from '../lib/renderer/html-collection.js';

test('HTMLCollection names, indices and expandos follow live legacy object rules', () => {
  const {window, document}=parseHTMLDocument('<div><i id="first" name="alias"></i><i id=""></i></div>');
  try {
    const {HTMLCollection, create}=htmlCollectionInterface();
    const parent=document.querySelector('div'), collection=create(parent.children, n=>n);
    expect(collection).toBeInstanceOf(HTMLCollection);
    expect(Array.isArray(collection)).toBe(false);
    expect(collection.forEach).toBeUndefined();
    expect(collection.namedItem('')).toBeNull();
    expect(Reflect.ownKeys(collection)).toEqual(['0','1','first','alias']);
    expect(collection.alias).toBe(collection[0]);
    expect(Reflect.set(collection,'first',1)).toBe(false);
    expect(Reflect.deleteProperty(collection,'first')).toBe(false);
    expect(Reflect.set(collection,'99',1)).toBe(false);
    expect(Reflect.deleteProperty(collection,'99')).toBe(true);
    collection.future=3;
    const added=document.createElement('i');added.id='future';parent.append(added);
    expect(collection.future).toBe(3);
    expect(collection.namedItem('future')).toBe(added);
    delete collection.future;
    expect(collection.future).toBe(added);
    const iterator=collection[Symbol.iterator]();iterator.next();collection[0].remove();
    expect(iterator.next().value).toBe(added);
    const child=Object.create(collection);child.future=4;
    expect(child.future).toBe(4);expect(collection.future).toBe(added);
    expect(()=>child.length).toThrow(TypeError);
    expect(Reflect.preventExtensions(collection)).toBe(false);
  } finally {window.happyDOM.close();}
});

test('namespace collections retain case, wildcard, null namespace and independent caches', () => {
  const {window,document}=parseHTMLDocument('<div></div>');
  try {
    const a=document.createElementNS('urn:a','Mixed'),b=document.createElementNS('urn:b','Mixed');
    const bare=document.createElementNS(null,'Mixed');
    document.body.append(a,b,bare);
    const one=document.getElementsByTagNameNS('urn:a','Mixed');
    const two=document.getElementsByTagNameNS('urn:b','Mixed');
    expect([...one]).toEqual([a]);expect([...two]).toEqual([b]);
    expect([...document.getElementsByTagNameNS('*','Mixed')]).toEqual([a,b,bare]);
    expect(document.getElementsByTagNameNS('urn:a','mixed').length).toBe(0);
    expect([...document.getElementsByTagNameNS('','Mixed')]).toEqual([bare]);
    const nested=document.createElementNS('urn:a','Mixed');a.append(nested);
    expect([...one]).toEqual([a,nested]);
    a.remove();expect(one.length).toBe(0);expect(two.length).toBe(1);
    const images=document.images;document.body.append(document.createElement('img'));
    expect(images.length).toBe(1);expect(document.images).toBe(images);
  } finally {window.happyDOM.close();}
});
