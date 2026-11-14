// Serialized with the QML runtime. Media bytes and clocks stay in HTML's engine.
// WebEngineView (QtWebEngine) is here too: like VideoOutput, an Item holding one HTML
// element, here an iframe the browser lays out, paints and scrolls itself.
export function createQmlMedia({document,elements,effect,untrack,watchWrite,cleanup,listen,host,emit,resolve}) {
  const outputs=new WeakMap();
  const defaults=(v,type)=>{
    if(type==='AudioOutput')Object.assign(v,{muted:false,volume:1});
    if(type==='IdleInhibitor')Object.assign(v,{window:null,enabled:false,supported:false});
    if(type==='VideoOutput')Object.assign(v,{fillMode:1,
      sourceRect:{x:0,y:0,width:0,height:0},contentRect:{x:0,y:0,width:0,height:0}});
    if(type==='WebEngineView')Object.assign(v,{url:'',title:'',loadProgress:0,zoomFactor:1,backgroundColor:'white',
      canGoBack:false,canGoForward:false,settings:{javascriptEnabled:true}});
    if(type==='MediaPlayer')Object.assign(v,{source:'',autoPlay:false,audioOutput:null,videoOutput:null,
      position:0,duration:0,playbackState:0,playing:false,mediaStatus:0,error:0,errorString:'',
      hasAudio:false,hasVideo:false,seekable:false,bufferProgress:0,loops:1});
  };
  function start(v,type) {
    if(type==='IdleInhibitor'){
      let warned=false;
      effect(()=>{if(v.enabled&&!warned){warned=true;console.warn('QML IdleInhibitor: sleep inhibition is unavailable; media playback continues.');}});
      return;
    }
    if(type==='WebEngineView'){startWebEngine(v);return;}
    if(type!=='MediaPlayer')return;
    const video=document.createElement('video');
    video.style.cssText='position:absolute;left:0;top:0;width:100%;height:100%;object-fit:contain;pointer-events:none';
    const owner=elements.get(v);owner.appendChild(video);
    const engine=host?.media?.(video);
    if(!engine){v.error=1;v.errorString='Media playback requires a local QML renderer';v.mediaStatus=7;return;}
    let disposed=false,updating=false,stopped=true,generation=0,source,output,repeats=0;
    const update=()=>{
      if(disposed)return;
      const s=engine.snapshot(),oldError=v.error;
      updating=true;
      try{
        v.position=Math.round((s.currentTime||0)*1000);
        v.duration=Number.isFinite(s.duration)?Math.round(s.duration*1000):0;
        v.hasAudio=s.hasAudio;v.hasVideo=s.hasVideo;v.seekable=s.ready;
        v.playing=!s.paused;
        v.playbackState=s.paused?(stopped||s.ended?0:2):1;
        v.mediaStatus=s.error?7:s.ended?6:!source?0:!s.ready?1:s.buffering?3:s.paused?2:5;
        v.bufferProgress=s.ready?1:0;
        if(s.error){v.error=s.error.code===2?2:3;v.errorString=s.error.message||'Media playback failed';}
        else {v.error=0;v.errorString='';}
        if(output){
          const w=s.videoWidth||0,h=s.videoHeight||0;
          output.sourceRect={x:0,y:0,width:w,height:h};
          const bw=Math.max(0,Number(output.width)||0),bh=Math.max(0,Number(output.height)||0);
          const scale=w&&h?(output.fillMode===2?Math.max(bw/w,bh/h):Math.min(bw/w,bh/h)):0;
          const dw=output.fillMode===0?bw:w*scale,dh=output.fillMode===0?bh:h*scale;
          output.contentRect={x:(bw-dw)/2,y:(bh-dh)/2,width:dw,height:dh};
          // Size the existing video node; do not rasterize a second picture.
          video.style.left=(bw-dw)/2+'px';video.style.top=(bh-dh)/2+'px';
          video.style.width=dw+'px';video.style.height=dh+'px';
        }
      }finally{updating=false;}
      if(v.error&&v.error!==oldError)emit(v,'onErrorOccurred',v.error,v.errorString);
    };
    const fail=e=>{if(disposed)return;v.error=1;v.errorString=String(e.message||e);v.mediaStatus=7;v.playbackState=0;v.playing=false;emit(v,'onErrorOccurred',v.error,v.errorString);};
    v.play=()=>{stopped=false;return Promise.resolve(engine.play()).then(update,fail);};
    v.pause=()=>{stopped=false;engine.pause();update();};
    v.stop=()=>{stopped=true;engine.pause();return Promise.resolve(engine.seek(0)).then(update,fail);};
    watchWrite(v,'position',()=>{if(!updating)Promise.resolve(engine.seek(Number(v.position)/1000)).then(update,fail);});
    effect(()=>{
      const target=v.videoOutput;
      const container=target?elements.get(target):owner;
      if(container&&video.parentElement!==container)container.appendChild(video);
      if(output!==target){if(output)outputs.delete(output);output=target;if(output)outputs.set(output,video);}
      if(target){elements.get(target).style.overflow='hidden';video.style.objectFit=target.fillMode===0?'fill':target.fillMode===2?'cover':'contain';}
      untrack(update);
    });
    effect(()=>engine.volume(v.audioOutput&&!v.audioOutput.muted?v.audioOutput.volume:0));
    effect(()=>{
      const url=v.source?resolve(v,v.source):'';
      if(url===source)return;
      source=url;const token=++generation;repeats=0;stopped=true;
      updating=true;
      try{v.error=0;v.errorString='';v.mediaStatus=url?1:0;v.position=0;v.duration=0;}finally{updating=false;}
      Promise.resolve(engine.source(url)).then(()=>{
        if(disposed||token!==generation)return;
        update();if(url&&v.autoPlay)return v.play();
      }).catch(e=>{if(token===generation)fail(e);});
    });
    for(const event of ['loadedmetadata','durationchange','play','playing','pause','timeupdate','seeked','waiting','error'])
      listen(video,event,update);
    listen(video,'ended',()=>{update();if(v.loops===-1||++repeats<Math.max(1,v.loops))void v.play();});
    effect(()=>{if(output){output.width;output.height;output.fillMode;untrack(update);}});
    cleanup(()=>{disposed=true;generation++;engine.dispose();if(output)outputs.delete(output);video.remove();});
  }
  // A subset of QtWebEngine's WebEngineView: url, loadHtml(html, baseUrl), reload, stop,
  // title, loadProgress, loadingChanged(loadingInfo) and navigationRequested(request). The iframe is always sandboxed
  // without allow-same-origin, so its document has an opaque origin and can never reach
  // the QML document; settings.javascriptEnabled (true by default, as in Qt) decides only
  // allow-scripts. runJavaScript and history are not available.
  function startWebEngine(v){
    const frame=document.createElement('iframe');
    frame.style.cssText='position:absolute;left:0;top:0;width:100%;height:100%;border:0;display:block';
    // Navigations the page starts (a link) come here first: navigationRequested(request),
    // as in Qt, where request.reject() keeps the view on its page.
    frame.setAttribute('data-buninu-navigation','');
    listen(frame,'buninu-navigation',event=>{
      let rejected=false;
      const request={url:String(event.detail?.url??''),navigationType:0,isMainFrame:true,hasFormData:false,
        accept(){rejected=false;},reject(){rejected=true;}};
      emit(v,'onNavigationRequested',request);
      if(rejected)event.preventDefault();
    });
    // Inserted only once its first page is set: an iframe inserted without src fires the load
    // of its initial about:blank, which could land after loadHtml and report success twice.
    const attach=()=>{if(!frame.isConnected&&!disposed)elements.get(v).appendChild(frame);};
    let current='',disposed=false;
    const info=(status,url)=>({url,status,errorString:'',errorCode:0,errorDomain:0,isErrorPage:false});
    const sandbox=()=>frame.setAttribute('sandbox',v.settings?.javascriptEnabled===false?'':'allow-scripts');
    const begin=url=>{current=url;v.loadProgress=0;emit(v,'onLoadingChanged',info(0,url));};
    v.loadHtml=(html,baseUrl='')=>{
      sandbox();frame.removeAttribute('src');
      begin(baseUrl?String(baseUrl):'about:srcdoc');
      frame.srcdoc=String(html??'');
      attach();
    };
    v.reload=()=>{
      sandbox();
      if(frame.hasAttribute('srcdoc'))frame.srcdoc=frame.getAttribute('srcdoc');
      else if(frame.hasAttribute('src'))frame.src=frame.getAttribute('src');
    };
    v.stop=()=>{};
    v.goBack=()=>{};
    v.goForward=()=>{};
    v.runJavaScript=(script,callback)=>{
      console.warn('QML WebEngineView: runJavaScript is not available; the view is sandboxed.');
      if(typeof callback==='function')callback(undefined);
    };
    effect(()=>{
      const url=v.url?resolve(v,v.url):'';
      if(!url||url===current)return;
      untrack(()=>{sandbox();frame.removeAttribute('srcdoc');begin(url);frame.src=url;attach();});
    });
    effect(()=>{frame.style.backgroundColor=String(v.backgroundColor??'white');});
    listen(frame,'load',()=>{
      if(disposed)return;
      v.loadProgress=100;
      emit(v,'onLoadingChanged',info(2,current));
    });
    cleanup(()=>{disposed=true;frame.remove();});
  }
  return {defaults,start};
}
