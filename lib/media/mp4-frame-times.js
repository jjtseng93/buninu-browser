// Presentation timestamps for ordinary (nonfragmented) MP4 video. FFmpeg
// returns decoded pictures in presentation order; average FPS cannot time VFR.
// Unsupported tables/edits retain the existing decoder clock.
export function mp4FrameTimes(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  try {
    const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    let seen=0;
    const u=(p,end)=>{if(p<0||p+4>end)throw Error('short field');return v.getUint32(p)};
    const boxes=(start,end)=>{
      const out=[];
      for(let p=start;p<end;){
        if(++seen>32768)throw Error('box limit');
        let size=u(p,end),header=8;const type=u(p+4,end);
        if(size===1){size=u(p+8,end)*4294967296+u(p+12,end);header=16}
        if(size===0)size=end-p;
        // Progressive files may end inside mdat; timing tables before it
        // are already complete and do not depend on the arriving payload.
        if(size>end-p && type===0x6d646174 && start===0)break;
        if(!Number.isSafeInteger(size)||size<header||size>end-p)throw Error('bad box');
        out.push({type,p:p+header,end:p+size});p+=size;
      }return out;
    };
    const tag=s=>[...s].reduce((n,c)=>n*256+c.charCodeAt(0),0);
    const find=(list,name)=>list.find(b=>b.type===tag(name));
    const children=b=>boxes(b.p,b.end);
    const top=boxes(0,bytes.length),moov=find(top,'moov');if(!moov)return null;
    const movie=children(moov);if(find(movie,'mvex'))return null;
    const tracks=movie.filter(b=>b.type===tag('trak'));
    let result=null;
    for(const trak of tracks){
      const nodes=children(trak),mdia=find(nodes,'mdia');if(!mdia)continue;
      const media=children(mdia),hdlr=find(media,'hdlr');
      if(!hdlr||u(hdlr.p+8,hdlr.end)!==tag('vide'))continue;
      if(result)return null;
      const mdhd=find(media,'mdhd');if(!mdhd||bytes[mdhd.p]>1)return null;
      const scale=u(mdhd.p+(bytes[mdhd.p]===1?20:12),mdhd.end);if(!scale)return null;
      let offset=0;const edts=find(nodes,'edts');
      if(edts){
        const edit=find(children(edts),'elst');
        if(!edit||bytes[edit.p]!==0||u(edit.p+4,edit.end)!==1||u(edit.p+16,edit.end)!==65536)return null;
        offset=u(edit.p+12,edit.end);if(offset>=2147483648)return null;
      }
      const minf=find(media,'minf');if(!minf)return null;
      const stbl=find(children(minf),'stbl');if(!stbl)return null;
      const tables=children(stbl),stts=find(tables,'stts'),ctts=find(tables,'ctts');if(!stts||bytes[stts.p]!==0)return null;
      const times=[],durations=[];let time=0;
      const runs=u(stts.p+4,stts.end);if(runs>250000)return null;
      for(let i=0;i<runs;i++){
        const count=u(stts.p+8+i*8,stts.end),delta=u(stts.p+12+i*8,stts.end);
        if(!delta||times.length+count>250000)return null;
        for(let j=0;j<count;j++){times.push(time);durations.push(delta);time+=delta;if(!Number.isSafeInteger(time))return null;}
      }
      if(ctts){
        if(bytes[ctts.p]>1)return null;let index=0;
        const runs=u(ctts.p+4,ctts.end);if(runs>250000)return null;
        for(let i=0;i<runs;i++){
          const count=u(ctts.p+8+i*8,ctts.end);let delta=u(ctts.p+12+i*8,ctts.end);
          if(bytes[ctts.p]===1)delta|=0;
          if(index+count>times.length)return null;
          for(let j=0;j<count;j++)times[index++]+=delta;
        }if(index!==times.length)return null;
      }
      const keys=[];const stss=find(tables,'stss');
      if(stss){const count=u(stss.p+4,stss.end);if(count>times.length)return null;
        for(let i=0;i<count;i++){const n=u(stss.p+8+i*4,stss.end);if(!n||n>times.length)return null;keys.push((times[n-1]-offset)/scale)}
      }else for(const t of times)keys.push((t-offset)/scale);
      const frames=Float64Array.from(times,t=>(t-offset)/scale);frames.sort();keys.sort((a,b)=>a-b);
      if(!frames.length||frames[0]<-1e-6)return null;
      let end=0;for(let i=0;i<times.length;i++)end=Math.max(end,(times[i]+durations[i]-offset)/scale);
      result={frames,keys,end};
    }return result;
  }catch{return null}
}

export function timeVideoDecoder(decoder,bytes) {
  const timeline=mp4FrameTimes(bytes);if(!timeline)return decoder;
  let index=0;
  return {
    width:decoder.width,height:decoder.height,fps:decoder.fps,
    get frameTime(){return timeline.frames[Math.max(0,index-1)]},
    get nextFrameTime(){return timeline.frames[index]??timeline.end},
    nextFrame(...args){const pixels=decoder.nextFrame(...args);if(pixels)index++;return pixels},
    seek(ms){
      decoder.seek(ms);const target=ms/1000;let key=timeline.keys[0]??0;
      for(const t of timeline.keys){if(t>target+1e-6)break;key=t}
      let low=0,high=timeline.frames.length;
      while(low<high){const mid=(low+high)>>>1;if(timeline.frames[mid]<key-1e-6)low=mid+1;else high=mid}
      index=low;
    },
    close(){decoder.close()},
  };
}
