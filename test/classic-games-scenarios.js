// Game-specific acceptance assertions only. Production compatibility fixes are generic.
export async function playClassicGame(c,game) {
 const evidence=[];
 const read=expression=>c.evaluate(expression,90000);
 const check=(condition,message)=>{if(!condition)throw Error(message);evidence.push(message);};
 const sleep=Bun.sleep;
 const castyKeys=process.env.CLASSIC_CASTY_KEYS;
 const casty=castyKeys?await import('../../casty/lib/keyboard-protocol.js'):null;
 const dispatch=casty?new casty.KeyboardDispatch(c):null;
 async function key(key,hold=60){
  if(dispatch && /^[a-z ]$/i.test(key)) {
   const info=casty.parseKittyKey(`\x1b[${key.codePointAt(0)}u`);
   await dispatch.send(info,castyKeys==='kitty');await sleep(hold);
   if(castyKeys==='kitty')await dispatch.send({...info,eventType:3},true);
   return;
  }
  const names={Escape:'Escape',' ':'Space',ArrowLeft:'ArrowLeft',ArrowRight:'ArrowRight',ArrowUp:'ArrowUp',ArrowDown:'ArrowDown',Enter:'Enter'};
  const codes={Escape:27,' ':32,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,Enter:13};
  const event={key,code:names[key]??'Key'+key.toUpperCase(),windowsVirtualKeyCode:codes[key]??key.toUpperCase().charCodeAt(0)};
  await c.send('Input.dispatchKeyEvent',{type:'rawKeyDown',...event});await sleep(hold);await c.send('Input.dispatchKeyEvent',{type:'keyUp',...event});
 }
 async function click(selector,index=0,button='left'){
  const point=await read(`(()=>{const e=document.querySelectorAll(${JSON.stringify(selector)})[${index}];if(!e)return null;e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height}})()`);
  if(!point?.w||!point?.h)throw Error('No visible target '+selector);
  for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,button,clickCount:1,x:point.x,y:point.y});
 }
 async function wait(expression,milliseconds=3000){const start=performance.now();while(performance.now()-start<milliseconds){if(await read(expression))return true;await sleep(60);}return false;}
 const pixels=async()=>{const {data}=await c.send('Page.captureScreenshot',{format:'png'});return Bun.hash(data).toString();};
 const start=async()=>{await click('#playBtn');await sleep(150);check(await read('(()=>{const e=document.getElementById("playBtn"),overlay=e.closest(".overlay");return e.getBoundingClientRect().width===0||overlay&&!overlay.classList.contains("show")})()'),'start hides the menu');};
 switch(game){
 case 'tetris':{
  const score=await read('Number(document.getElementById("score-val").textContent)');
  await key('ArrowLeft');await key('ArrowUp');await key(' ');
  check(await wait('Number(document.getElementById("score-val").textContent)>'+score,15000),'hard drop locks a piece and increases score');
  await key('p');check(await read('document.getElementById("pause-overlay").classList.contains("show")'),'P shows the pause overlay');await key('p');check(await read('!document.getElementById("pause-overlay").classList.contains("show")'),'P resumes the game');break;
 }
 case 'snake':{
  // Observe the two head eyes in rendered Canvas output. Their relative
  // positions reveal direction without reaching into the game's closure.
  await read(`(()=>{window.__snakeEyes=[];const arc=CanvasRenderingContext2D.prototype.arc;CanvasRenderingContext2D.prototype.arc=function(x,y,r,...args){if(r===2.2){window.__snakeEyes.push([x,y]);if(window.__snakeEyes.length>32)window.__snakeEyes.shift()}return arc.call(this,x,y,r,...args)}})()`);
  const heading=`(()=>{const a=window.__snakeEyes.at(-2),b=window.__snakeEyes.at(-1);if(!a||!b)return '';const dx=a[0]-b[0],dy=a[1]-b[1];return Math.abs(dx)>Math.abs(dy)?(dx>0?'up':'down'):(dy>0?'right':'left')})()`;
  await start();check(await wait(heading+"==='right'"),'snake initially faces right');
  await key('ArrowLeft');await sleep(200);
  check(await read(heading+"==='right'"),'direct reversal into the body is rejected');
  for(const [input,direction] of [['ArrowUp','up'],['ArrowLeft','left'],['ArrowDown','down'],['ArrowRight','right']]){
   await key(input);check(await wait(heading+'==='+JSON.stringify(direction)),input+' turns the snake '+direction);
  }
  break;
 }
 case '2048':{
  const tiles=()=>read('JSON.stringify([...document.querySelectorAll(".tile")].map(e=>[e.textContent,e.style.left,e.style.top]))');
  await key('ArrowLeft');await sleep(180);const before=await tiles();
  await key('ArrowRight');await sleep(180);check(before!==await tiles(),'arrow moves/spawns numbered tiles');
  await click('#undoBtn');await sleep(160);check(before===await tiles(),'undo restores the previous board');break;
 }
 case 'flappy':{
  await read(`(()=>{window.__classicText=[];const original=CanvasRenderingContext2D.prototype.fillText;CanvasRenderingContext2D.prototype.fillText=function(text,...args){window.__classicText.push(String(text));if(window.__classicText.length>500)window.__classicText.shift();return original.call(this,text,...args)}})()`);
  await key(' ');await sleep(120);
  check(await wait('window.__classicText.some(text=>/^0$/.test(text))'),'Space starts the game and draws the score');
  await key(' ');await sleep(150);check(await read('!window.__classicText.some(text=>text==="GAME OVER")'),'another flap keeps the bird alive');
  await key('p');await key('p');break;
 }
 case 'space':{
  await key(' ');const before=await pixels();await key('ArrowRight',200);await key(' ',350);await sleep(150);
  check(before!==await pixels(),'shooting/movement advances the game canvas');break;
 }
 case 'ttt':{
  await click('.cell',0);check(await wait('document.querySelectorAll(".mark-svg").length>=2'),'human move and AI response both draw marks');
  await click('#btnNew');check(await read('document.querySelectorAll(".mark-svg").length===0'),'new game clears the board');break;
 }
 case 'memory':{
  const cards=await read('[...document.querySelectorAll(".card")].map(e=>e.querySelector(".card-emoji").textContent)');
  const first=cards.findIndex((value,index)=>cards.indexOf(value)!==index),other=cards.indexOf(cards[first]);
  await click('.card',other);await sleep(100);check(await read('document.querySelectorAll(".card.flipped").length===1'),'one click flips one card');
  await click('.card',first);check(await wait('document.querySelectorAll(".card.matched").length===2'),'matching cards are retained as a pair');break;
 }
 case 'mine':{
  await click('#board .cell',0,'right');check(await read('document.querySelectorAll("#board .flag").length===1'),'right click sets a flag');
  await click('#board .cell',0,'right');check(await read('document.querySelectorAll("#board .flag").length===0'),'second right click removes the flag');
  await click('#board .cell',0);check(await wait('document.querySelectorAll("#board .revealed").length>0||document.querySelectorAll("#board .open").length>0||document.querySelectorAll("#board .rv").length>0'),'left click opens cells');break;
 }
 case 'pong':case 'breakout':{
  await start();const before=await pixels();
  const rect=await read('(()=>{const r=document.getElementById("game").getBoundingClientRect();return {x:r.x+r.width*.8,y:r.y+r.height*.8}})()');
  await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',...rect});await key('ArrowRight',150);
  if(game==='breakout')await key(' ');
  await sleep(500);check(before!==await pixels(),'paddle and ball update after input');break;
 }
 case 'dino':{
  await start();const before=await pixels();await key(' ');await sleep(300);check(before!==await pixels(),'jump/runner animation advances');break;
 }
 case 'sudoku':{
  await start();await click('#notesBtn');check(await read('document.getElementById("notesBtn").textContent.includes("On")'),'notes mode toggles');
  await click('#notesBtn');const before=await pixels();await click('#hintBtn');await sleep(120);check(before!==await pixels(),'hint fills a cell');break;
 }
 case 'connect4':{
  check(await read(`(()=>{const cols=[...document.querySelectorAll('.col')];return cols.length===7&&cols.every((col,index)=>{const cells=[...col.querySelectorAll('.cell')].map(e=>e.getBoundingClientRect()),r=col.getBoundingClientRect();return cells.length===6&&cells.every((cell,i)=>cell.width>0&&Math.abs(cell.x-cells[0].x)<1&&(!i||cell.bottom<=cells[i-1].top))&&(!index||r.left>=cols[index-1].getBoundingClientRect().right)})})()`),'seven non-overlapping columns contain six vertically reversed cells');
  for(const col of [0,1,0,1,0,1,0]){await click('.col',col);await sleep(450);}
  check(await wait('document.getElementById("gameOverOverlay").classList.contains("show")'),'four connected discs trigger the winner overlay');
  check(await read('Number(document.getElementById("scoreRed").textContent)===1'),'winning round updates score');break;
 }
 case 'typing':{
  await click('#startBtn');const word=await read('document.querySelector(".word.current").textContent');
  await click('#wordInput');for(const char of word+' ')await c.send('Input.insertText',{text:char});
  check(await read('document.querySelectorAll(".word.correct").length>0||currentWordIdx>0'),'typing the current word advances the exercise');
  const mute=await read('document.getElementById("muteBtn").textContent');
  for(const char of 'pPmM'){
   const event={key:char,code:'Key'+char.toUpperCase(),windowsVirtualKeyCode:char.toUpperCase().charCodeAt(0),modifiers:char===char.toUpperCase()?8:0};
   await c.send('Input.dispatchKeyEvent',{type:'rawKeyDown',...event});
   await c.send('Input.dispatchKeyEvent',{type:'char',...event,text:char});
   await c.send('Input.dispatchKeyEvent',{type:'keyUp',...event});
  }
  check(await read('document.getElementById("wordInput").value==="pPmM"&&!isPaused'),'P and M remain ordinary input in both letter cases');
  check(await read('document.getElementById("muteBtn").textContent')===mute,'typing M does not toggle sound');
  await key('Escape');check(await read('isPaused&&document.getElementById("wordInput").disabled'),'Escape pauses while the input is focused');
  await key('Escape');check(await read('!isPaused&&!document.getElementById("wordInput").disabled'),'Escape resumes typing');break;
 }
 case 'simon':{
  await read(`(()=>{window.__classicLights=[];new MutationObserver(records=>{for(const record of records)if(record.target.matches('.quadrant.active'))window.__classicLights.push(record.target.dataset.idx)}).observe(document.getElementById('board'),{subtree:true,attributes:true,attributeFilter:['class']})})()`);
  await click('#startBtn');let index=null;
  for(let n=0;n<30;n++){index=await read('window.__classicLights[0]??null');if(index!==null)break;await sleep(35);}
  check(index!==null,'first sequence visibly lights a quadrant');
  check(await wait('document.getElementById("status").textContent.includes("Your turn")'),'sequence switches to player input');
  await click(`.quadrant[data-idx="${index}"]`);check(await wait('Number(document.getElementById("roundDisplay").textContent)>=2'),'correct quadrant advances to round two');break;
 }
 case 'puzzle15':{
  check(await read('document.querySelectorAll("#puzzleGrid .tile").length===15'),'fifteen numbered tiles are rendered');
  const index=await read(`(()=>{const g=document.getElementById('puzzleGrid'),r=g.getBoundingClientRect(),cs=r.width/4;const tiles=[...g.querySelectorAll('.tile')],positions=tiles.map(e=>{const t=e.getBoundingClientRect();return [Math.round((t.x-r.x)/cs),Math.round((t.y-r.y)/cs)]});let empty;for(let y=0;y<4;y++)for(let x=0;x<4;x++)if(!positions.some(p=>p[0]===x&&p[1]===y))empty=[x,y];return positions.findIndex(p=>Math.abs(p[0]-empty[0])+Math.abs(p[1]-empty[1])===1)})()`);
  await click('#puzzleGrid .tile',index);check(await read('Number(document.getElementById("moveCount").textContent)>0'),'adjacent tile slides and increases move count');break;
 }
 }
 return evidence;
}
