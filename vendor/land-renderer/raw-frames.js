import {mkdtempSync,writeFileSync,readdirSync,statSync,unlinkSync,rmSync,realpathSync,openSync,writevSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

// The producer owns the directory; Kitty t=t consumers unlink individual frames.
// A worker borrows a directory owned by its parent, so terminating the worker
// cannot skip cleanup. No pixel data is encoded into the CDP response.
export class RawFrames {
  constructor({directory,ownsDirectory=true}={}) {
    this.externalDirectory=directory;this.ownsDirectory=ownsDirectory;
    this.sequence=0;this.closed=false;
    this.onExit=()=>this.close();
  }
  get directory() {
    if(this.closed)throw Error('Raw frame store is closed');
    if(!this.path){
      this.path=this.externalDirectory ? this.externalDirectory() : realpathSync(mkdtempSync(join(tmpdir(),'tty-graphics-protocol-land-')));
      if(!this.path)throw Error('Missing raw frame directory');
      if(this.ownsDirectory)process.once('exit',this.onExit);
    }
    return this.path;
  }
  write(bytes,width,height,format,patch) {
    const directory=this.directory;
    let count=0,total=0;
    for(const name of readdirSync(directory)){
      const path=join(directory,name);
      try{
        const stat=statSync(path);
        if(Date.now()-stat.mtimeMs>60000){unlinkSync(path);continue;}
        count++;total+=stat.size;
      }catch(error){if(error.code!=='ENOENT')throw error;}
    }
    if(count>=16||total+bytes.byteLength>128*1024*1024)throw Error('Raw frame consumer stalled');
    const path=join(directory,`${++this.sequence}.${format}`);
    if(!patch)writeFileSync(path,bytes,{flag:'wx',mode:0o600});
    else {
      // Scatter the immutable background and small overlay directly into the
      // file, avoiding both a desktop-sized copy and one write per cursor row.
      const chunks=[];let offset=0;
      for(let y=0;y<patch.height;y++){
        const start=((patch.y+y)*width+patch.x)*4;
        if(start>offset)chunks.push(bytes.subarray(offset,start));
        chunks.push(patch.bytes.subarray(y*patch.width*4,(y+1)*patch.width*4));
        offset=start+patch.width*4;
      }
      if(offset<bytes.length)chunks.push(bytes.subarray(offset));
      const fd=openSync(path,'wx',0o600);
      try{
        let index=0;
        while(index<chunks.length){
          let written=writevSync(fd,chunks.slice(index,index+512));
          if(written<=0)throw Error('Short raw frame write');
          while(index<chunks.length&&written>=chunks[index].length){written-=chunks[index++].length;}
          if(written)chunks[index]=chunks[index].subarray(written);
        }
      }catch(error){try{unlinkSync(path);}catch{}throw error;}finally{closeSync(fd);}
    }
    return JSON.stringify({version:1,transport:'file',path,width,height,stride:width*4,format,bytes:bytes.byteLength});
  }
  close(){
    if(this.closed)return;this.closed=true;
    process.removeListener('exit',this.onExit);
    if(this.ownsDirectory&&this.path)rmSync(this.path,{recursive:true,force:true});
  }
}
