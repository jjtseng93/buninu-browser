import {mkdtempSync,writeFileSync,readdirSync,statSync,unlinkSync,rmSync,realpathSync} from 'node:fs';
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
      this.path=this.externalDirectory ? this.externalDirectory() : realpathSync(mkdtempSync(join(tmpdir(),'tty-graphics-protocol-browser-')));
      if(!this.path)throw Error('Missing raw frame directory');
      if(this.ownsDirectory)process.once('exit',this.onExit);
    }
    return this.path;
  }
  write(bytes,width,height,format) {
    if (!['rgba','bgra'].includes(format) || !Number.isInteger(width) || !Number.isInteger(height)
        || width<1 || height<1 || width*height>16777216 || !(bytes instanceof Uint8Array)
        || bytes.byteLength!==width*height*4) throw Error('Invalid raw frame');
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
    writeFileSync(path,bytes,{flag:'wx',mode:0o600});
    return JSON.stringify({version:1,transport:'file',path,width,height,stride:width*4,format,bytes:bytes.byteLength});
  }
  close(){
    if(this.closed)return;this.closed=true;
    process.removeListener('exit',this.onExit);
    if(this.ownsDirectory&&this.path)rmSync(this.path,{recursive:true,force:true});
  }
}
