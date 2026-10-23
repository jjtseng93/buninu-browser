// Local QML adapter to the existing HTML media engine. No decoder/output backend.
export function createQmlMediaController(element,api) {
  let closed=false,version=0,gain=1;
  const current=()=>!closed&&api.valid(element);
  const release=()=>{
    const state=api.state(element);
    if(state){
      const pending=state.loading;
      state.document=null;
      api.close(state);
      // In-flight probing may finish after disposal. Release its late decoders
      // without closing the replacement source's state.
      pending?.then(()=>api.close(state),()=>api.close(state));
    }
    api.forget(element);
  };
  return {
    async source(url) {
      const generation=++version;release();
      if(!current())return;
      element.setAttribute('src',url);
      if(!url)return;
      const state=api.ensure(element);
      if(!state)throw Error('Media decoder unavailable');
      try {
        await api.load(state);
        if(!current()||generation!==version)return;
        await api.seek(element,0);
      } catch(error) {if(current()&&generation===version)throw error;}
    },
    play:()=>current()?api.play(element):undefined,
    pause:()=>{if(current())api.pause(element);},
    seek:seconds=>current()?api.seek(element,seconds):undefined,
    snapshot() {
      const state=api.state(element),status=api.snapshot(element);
      return {...status,hasAudio:!!state?.hasAudio,hasVideo:!!state?.hasVideo,
        ready:!!state?.probed,error:api.error(element),buffering:!!state?.buffering};
    },
    volume(value) {gain=Math.max(0,Math.min(1,Number(value)||0));api.gains.set(element,gain);},
    dispose(){if(closed)return;closed=true;version++;release();api.gains.delete(element);},
  };
}
// PCM already belongs to the output chunk; do not copy or touch decoder history.
export function applyQmlMediaGain(pcm,gain) {
  if(gain===undefined||gain===1)return;
  if(gain===0){pcm.fill(0);return;}
  const view=new DataView(pcm.buffer,pcm.byteOffset,pcm.byteLength);
  for(let i=0;i+1<pcm.byteLength;i+=2)view.setInt16(i,Math.round(view.getInt16(i,true)*gain),true);
}
