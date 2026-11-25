import {serviceWebAudio} from '../web-audio-demand.js';

// A cached tile includes its incoming destination because blending and shader
// discard can both preserve pixels from earlier draws.
export class TileReplay {
  clear() { this.last = null; }

  begin(program, samplers, state, vertices, stride) {
    const previous = this.last;
    const bindings = [program.vertex, program.fragment, stride, ...state];
    for (const uniform of program.fragment.uniforms) {
      // Uniform setters capture numbers or replace arrays, never mutate them.
      if (!uniform.elements) bindings.push(program.values.get(uniform.name));
    }
    for (const t of samplers) {
      // A framebuffer texture can change in place. Ordinary uploads replace
      // their storage and receive a new version unique within this context.
      if (t.topDown || t.volume) return null;
      bindings.push(t.version, t.width, t.height, t.mag, t.min, t.wrapS, t.wrapT);
    }
    const current = {bindings, tiles: new Map()};
    this.last = current;
    if (!previous || previous.bindings.length !== bindings.length ||
        !previous.bindings.every((value, i) => Object.is(value, bindings[i]))) {
      return null; // One-off draws need neither a mesh snapshot nor pixel storage.
    }
    const geometry = new Uint32Array(vertices.buffer, vertices.byteOffset, vertices.length);
    current.geometry = geometry;
    let indexCount = 0;
    return (id, triangles, rect, target, width, draw) => {
      const [x, y, w, h] = rect;
      // Screen-sized primitives appear in many bins. Limit retained indices
      // independently of the number of source vertices.
      indexCount += triangles.length * 3;
      if (indexCount > 262144) {
        draw();
        return;
      }
      let tile = previous.tiles.get(id);
      const sameRect = tile && tile.x === x && tile.y === y && tile.w === w && tile.h === h;
      if (sameRect && matchesMesh(tile.indices, triangles, previous.geometry, geometry, stride) &&
          matchesPixels(target, width, tile)) {
        serviceWebAudio();
        for (let row = 0; row < h; row++) {
          target.set(tile.after.subarray(row * w, (row + 1) * w), (y + row) * width + x);
        }
      } else {
        if (!sameRect) tile = {x, y, w, h, before: new Uint32Array(w*h), after: new Uint32Array(w*h)};
        copyPixels(tile.before, target, width, tile);
        draw();
        copyPixels(tile.after, target, width, tile);
      }
      // Equal vertices can occupy different slots in the new mesh.
      saveIndices(tile, triangles);
      current.tiles.set(id, tile);
    };
  }
}

function saveIndices(tile, triangles) {
  const length = triangles.length * 3;
  if (tile.indices?.length !== length) tile.indices = new Uint32Array(length);
  let at = 0;
  for (const tri of triangles) {
    for (const id of tri.ids) tile.indices[at++] = id;
  }
}

function matchesMesh(indices, triangles, previous, current, stride) {
  if (indices.length !== triangles.length * 3) return false;
  let at = 0;
  for (const tri of triangles) {
    for (const id of tri.ids) {
      const oldStart = indices[at++] * stride, start = id * stride;
      for (let k = 0; k < stride; k++) {
        if (previous[oldStart + k] !== current[start + k]) return false;
      }
    }
  }
  return true;
}

function matchesPixels(target, width, {x, y, w, h, before}) {
  for (let row = 0; row < h; row++) {
    const start = (y + row) * width + x;
    for (let i = 0; i < w; i++) {
      if (before[row * w + i] !== target[start + i]) return false;
    }
  }
  return true;
}

function copyPixels(to, from, width, {x, y, w, h}) {
  for (let row = 0; row < h; row++) {
    const start = (y + row) * width + x;
    to.set(from.subarray(start, start + w), row * w);
  }
}
