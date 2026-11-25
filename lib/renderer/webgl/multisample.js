import {writeFragment} from './color-buffer.js';
import {serviceWebAudio} from '../web-audio-demand.js';

// Offsets from the pixel center, with y increasing down the framebuffer.
const center = [[0,0]];
const diagonal = [[-.25,.25],[.25,-.25]];
const rotated = [[-.125,.375],[.375,.125],[-.375,-.125],[.125,-.375]];
export function samplePositions(samples) {
  return samples === 4 ? rotated : samples === 2 ? diagonal : center;
}

// Resolve matching color formats in GL coordinates directly into the target.
// Uint8Array truncates a fractional average, so round normalized values first.
export function resolveColor(planes, target, sw, sh, dw, dh, x0, y0, x1, y1) {
  const bytes = target instanceof Uint8Array;
  const [a,b,c,d] = planes;
  for (let y=y0; y<y1; y++) {
    let src=((sh-1-y)*sw+x0)*4, dst=((dh-1-y)*dw+x0)*4;
    const end=src+(x1-x0)*4;
    if (!b) {
      if (end>src) target.set(a.subarray(src,end),dst);
      continue;
    }
    for (; src<end; src++,dst++) {
      const value = d ? (a[src]+b[src]+c[src]+d[src])*.25 : (a[src]+b[src])*.5;
      target[dst] = bytes ? Math.round(value) : value;
    }
  }
}

// Coverage and depth belong to individual samples. Interpolants and derivatives
// belong to the fragment. Evaluate them once before updating the surviving samples.
export function rasterMultisample(triangles, vertices, stride, varyingOffsets, varyings, shader, multi, state, passesDepth, runTile, derivatives) {
  const {width,height,blend,blending,paintColor,depthTest,depthFunc,writeDepth} = state;
  if (!shader && !runTile && !(depthTest && writeDepth)) return;
  const {planes,offsets} = multi;
  const depths = new Float32Array(planes.length);
  const helperDepth = new Float32Array(3);
  const inputOffsets = varyings.map(v=>varyingOffsets.get(v.name));
  const lanes = (shader?.prepare||derivatives) ? 3 : 1;
  const scratch=shader?.inputs??(runTile?varyings.map(()=>new Float32Array(4*lanes)):null);
  let packet;
  for (const tri of triangles) {
    const {p,ids,area,edgeMask,facing} = tri;
    const [a,b,c] = p;
    const ax=(b[1]-c[1])/area, ay=(c[0]-b[0])/area;
    const bx=(c[1]-a[1])/area, by=(a[0]-c[0])/area;
    const base0=ids[0]*stride, base1=ids[1]*stride, base2=ids[2]*stride;
    for (let y=tri.y0; y<=tri.y1; y++) {
      if ((y&15)===0) serviceWebAudio();
      for (let x=tri.x0; x<=tri.x1; x++) {
        const px=x+.5, py=y+.5, pixel=y*width+x;
        let mask=0;
        for (let i=0; i<offsets.length; i++) {
          const sx=px+offsets[i][0], sy=py+offsets[i][1];
          const u=((b[0]-sx)*(c[1]-sy)-(b[1]-sy)*(c[0]-sx))/area;
          const v=((c[0]-sx)*(a[1]-sy)-(c[1]-sy)*(a[0]-sx))/area;
          const w=((a[0]-sx)*(b[1]-sy)-(a[1]-sy)*(b[0]-sx))/area;
          if (u<0||v<0||w<0||(!u&&!(edgeMask&1))||(!v&&!(edgeMask&2))||(!w&&!(edgeMask&4))) continue;
          const z=Math.fround((u*a[2]+v*b[2]+w*c[2])*.5+.5);
          if (z<0||z>1||(depthTest&&(!runTile||!writeDepth||depthFunc!==517)&&!passesDepth(depthFunc,z,planes[i].depth[pixel]))) continue;
          depths[i]=z;
          mask |= 1<<i;
        }
        if (!mask) continue;
        if (scratch) {
          const dx=x%2?-1:1, dy=y%2?-1:1;
          const centerU=((b[0]-px)*(c[1]-py)-(b[1]-py)*(c[0]-px))/area;
          const centerV=((c[0]-px)*(a[1]-py)-(c[1]-py)*(a[0]-px))/area;
          for (let lane=0; lane<lanes; lane++) {
            const u=centerU+(lane===1?dx*ax:lane===2?dy*ay:0);
            const v=centerV+(lane===1?dx*bx:lane===2?dy*by:0);
            const w=1-u-v, invW=1/(u*a[3]+v*b[3]+w*c[3]);
            helperDepth[lane]=(u*a[2]+v*b[2]+w*c[2])*.5+.5;
            const w0=u*a[3]*invW, w1=v*b[3]*invW, w2=w*c[3]*invW;
            for (let k=0; k<varyings.length; k++) {
              const offset=inputOffsets[k], spec=varyings[k];
              if (offset===undefined) continue;
              for (let j=0; j<spec.size; j++) {
                const o=offset+j;
                scratch[k][lane*4+j]=spec.flat ? vertices[base2+o] :
                  w0*vertices[base0+o]+w1*vertices[base1+o]+w2*vertices[base2+o];
              }
            }
          }
          if(runTile){
            packet??=fragmentPacket(runTile,varyings,lanes,planes,state,passesDepth,triangles);
            packet.append(scratch,pixel,px,height-py,facing,dx,dy,helperDepth,mask,depths);
            continue;
          }
          const kept=shader.prepare?.(0,4,px,height-py,facing,dx,dy,helperDepth[0],helperDepth[1],helperDepth[2]);
          if ((kept??shader.shade(0,px,height-py,helperDepth[0],facing,false))===false) continue;
        }
        for (let i=0; i<planes.length; i++) {
          if (!(mask&(1<<i))) continue;
          if (depthTest&&writeDepth) planes[i].depth[pixel]=depths[i];
          if (paintColor) writeFragment(shader.result,0,planes[i].color,pixel*4,blend,blending);
        }
      }
    }
  }
  packet?.flush();
}

// A CanvasKit RuntimeEffect shades a rectangle. Pack covered fragments from
// successive primitives into a small rectangle and retain each destination
// and depth until it returns. Commit in submission order, rechecking depth
// since an earlier fragment in the packet can discard or update the sample.
function fragmentPacket(runTile,varyings,lanes,planes,state,passesDepth,triangles) {
  // A primitive produces at most one fragment per pixel in its bounds.
  // Small meshes need only that many tracked destinations and helper lanes.
  let limit=0;
  for(const t of triangles){
    limit+=(t.x1-t.x0+1)*(t.y1-t.y0+1);
    if(limit>=1024){limit=1024;break;}
  }
  const width=Math.min(64,limit),capacity=width*Math.ceil(limit/width);
  const {depthTest,depthFunc,writeDepth,paintColor,blend,blending}=state;
  const coverage=new Float32Array(capacity*lanes*4);
  const inputs=varyings.map(()=>new Float32Array(coverage.length));
  const destinations=new Uint32Array(capacity), masks=new Uint8Array(capacity);
  const sampleDepth=new Float32Array(capacity*planes.length);
  let used=0;
  function flush(){
    if(!used)return;
    const cols=Math.min(used,width),rows=Math.ceil(used/cols),size=cols*rows;
    coverage.fill(0,used*4,size*4);
    // CanvasKit takes contiguous images. Pack the last partial batch's
    // derivative planes at its actual height before uploading the images.
    function packed(data){
      if(size===capacity)return data;
      for(let lane=1;lane<lanes;lane++){
        data.copyWithin(lane*size*4,lane*capacity*4,(lane*capacity+used)*4);
      }
      return data.subarray(0,size*lanes*4);
    }
    runTile(packed(coverage),size===capacity?inputs:inputs.map(packed),cols,rows,0,0,pixels=>{
      for(let j=0;j<used;j++){
        if(!coverage[j*4+3])continue;
        const dest=destinations[j],mask=masks[j];
        for(let i=0;i<planes.length;i++){
          if(!(mask&(1<<i)))continue;
          const z=sampleDepth[j*planes.length+i],plane=planes[i];
          if(depthTest&&!passesDepth(depthFunc,z,plane.depth[dest]))continue;
          if(depthTest&&writeDepth)plane.depth[dest]=z;
          if(paintColor)writeFragment(pixels,j*4,plane.color,dest*4,blend,blending);
        }
      }
    });
    used=0;
  }
  function append(regs,pixel,x,y,front,dx,dy,z,mask,depths){
    const slot=used++;
    destinations[slot]=pixel;masks[slot]=mask;
    sampleDepth.set(depths,slot*planes.length);
    for(let lane=0;lane<lanes;lane++){
      const at=(slot+lane*capacity)*4;
      coverage[at]=(front?1:-1)*(4+x+(lane===1?dx:0));
      coverage[at+1]=y-(lane===2?dy:0);coverage[at+2]=z[lane];coverage[at+3]=dy===1?2:3;
      for(let k=0;k<inputs.length;k++)for(let j=0;j<varyings[k].size;j++) inputs[k][at+j]=regs[k][4*lane+j];
    }
    if(used===capacity)flush();
  }
  return {append,flush};
}
