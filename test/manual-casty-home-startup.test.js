import {test, expect} from 'bun:test';
import {KittyPeer, isCastyContentFrame} from './manual-casty-home-startup.js';

// Only the IHDR is needed to classify a benchmark frame; no raster decode.
function png(width = 1272, height = 780) {
  const bytes = Buffer.alloc(24);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  bytes.writeUInt32BE(13,8);bytes.write('IHDR',12);
  bytes.writeUInt32BE(width,16);bytes.writeUInt32BE(height,20);
  return bytes;
}
const packet = (header, payload) => `\x1b_G${header};${payload}\x1b\\`;
const placement = {i:'1',c:'159',r:'39'};

test('benchmark only accepts the page image at its content dimensions and placement', () => {
  expect(isCastyContentFrame(png(), placement)).toBeTrue();
  expect(isCastyContentFrame(png(1272,60), {...placement,r:'3'})).toBeFalse();
  expect(isCastyContentFrame(png(), {...placement,i:'200'})).toBeFalse();
  expect(isCastyContentFrame(png(), {...placement,r:'3'})).toBeFalse();
  expect(isCastyContentFrame(png(1280,780), placement)).toBeFalse();
  expect(isCastyContentFrame(Buffer.alloc(24), placement)).toBeFalse();
  expect(isCastyContentFrame(Buffer.alloc(2), placement)).toBeFalse();
});

test('chunked inline page frames retain their first packet placement across fragmented input', () => {
  const frames = [], replies = [], bytes = png(), payload = bytes.toString('base64');
  const peer = new KittyPeer({write:value=>replies.push(value), frame:(...args)=>frames.push(args)});
  const stream = '\x1b[14t\x1b[16t' + packet('a=T,f=100,i=1,c=159,r=39,m=1',payload.slice(0,13))
    + packet('m=0',payload.slice(13));
  for (let i=0;i<stream.length;i+=7) peer.feed(stream.slice(i,i+7));
  expect(replies).toEqual(['\x1b[4;800;1280t','\x1b[6;20;8t']);
  expect(frames).toHaveLength(1);
  expect(frames[0][0]).toEqual(bytes);expect(frames[0][1]).toBe('inline');
  expect(isCastyContentFrame(frames[0][0],frames[0][2])).toBeTrue();
});

test('later inline overlays do not replace the last page frame', () => {
  const accepted = [], overlay = png(1272,60), content = png();
  const peer = new KittyPeer({write:()=>{}, frame:(bytes,_transport,fields)=>{
    if (isCastyContentFrame(bytes,fields)) accepted.push(bytes);
  }});
  peer.feed(packet('a=T,f=100,i=1,c=159,r=39',content.toString('base64'))
    + packet('a=T,f=100,i=200,p=200,c=159,r=3',overlay.toString('base64')));
  expect(accepted).toEqual([content]);
});

test('file frames preserve placement while ignored temporary overlays are still cleaned up', () => {
  const files = new Map([['/page.png',png()],['/overlay.png',png(1272,60)]]);
  const accepted = [], removed = [];
  const peer = new KittyPeer({file:true,write:()=>{},read:path=>files.get(path),remove:path=>removed.push(path),frame:(bytes,transport,fields)=>{
    if (isCastyContentFrame(bytes,fields)) accepted.push({bytes,transport});
  }});
  peer.feed(packet('a=T,f=100,t=f,i=1,c=159,r=39',Buffer.from('/page.png').toString('base64'))
    + packet('a=T,f=100,t=t,i=200,c=159,r=3',Buffer.from('/overlay.png').toString('base64')));
  expect(accepted).toEqual([{bytes:files.get('/page.png'),transport:'file'}]);
  expect(removed).toEqual(['/overlay.png']);
});
