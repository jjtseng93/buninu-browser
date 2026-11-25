// Vertex-array state owns the element buffer and attribute records. ARRAY_BUFFER
// is a context binding: vertexAttribPointer captures it at specification time.
export function vertexArrayState(fail) {
  const arrays = new WeakMap();
  const initial = () => ({ attributes: new Map(), elements: null });
  const defaultArray = initial();
  let bound = null;
  const current = () => arrays.get(bound) ?? defaultArray;
  const methods = {
    createVertexArray() {
      const handle = Object.create(null);
      Object.defineProperty(handle, Symbol.toStringTag, { value: 'WebGLVertexArrayObject' });
      arrays.set(handle, initial());
      return handle;
    },
    bindVertexArray(handle) {
      if (handle !== null && !arrays.has(handle)) return fail(0x0502);
      bound = handle;
      if (bound) current().used = true;
    },
    isVertexArray(handle) { return !!arrays.get(handle)?.used; },
    deleteVertexArray(handle) {
      if (handle === bound) bound = null;
      arrays.delete(handle);
    },
    vertexAttribDivisor(slot, divisor) {
      if (slot >= 16 || slot < 0) return fail(0x0501);
      const attributes = current().attributes;
      attributes.set(slot, { ...attributes.get(slot), divisor: divisor >>> 0 });
    },
  };
  return { current, methods, binding: () => bound };
}

const formats = new Map([
  [0x1400, ['getInt8', 1, 127]], [0x1401, ['getUint8', 1, 255]],
  [0x1402, ['getInt16', 2, 32767]], [0x1403, ['getUint16', 2, 65535]],
  [0x1404, ['getInt32', 4, 2147483647]], [0x1405, ['getUint32', 4, 4294967295]],
  [0x1406, ['getFloat32', 4, 0]],
]);

const littleEndian=new Uint8Array(new Uint16Array([1]).buffer)[0]===1;

// The element buffer owns one decoded range. Draw commands hold the snapshot
// until they execute, including across a later bufferSubData on the same VAO.
export function elementRange(buffer, bytes, offset, count, fixedRestart) {
  const previous = buffer.range;
  if (previous && previous.bytes === bytes && previous.offset === offset &&
      previous.count === count && previous.fixedRestart === fixedRestart) return previous;
  const Word = bytes === 4 ? Uint32Array : bytes === 2 ? Uint16Array : Uint8Array;
  const start = buffer.data.byteOffset + offset;
  let indices;
  if (littleEndian && start % bytes === 0) {
    indices = new Word(buffer.data.buffer, start, count).slice();
  } else {
    indices = new Word(count);
    const source = new DataView(buffer.data.buffer, start, count * bytes);
    const read = bytes === 4 ? 'getUint32' : bytes === 2 ? 'getUint16' : 'getUint8';
    for (let i=0; i<count; i++) indices[i] = source[read](i*bytes, true);
  }
  const marker = fixedRestart ? 2**(8*bytes)-1 : -1;
  let maximum = -1, restart;
  for (let i=0; i<count; i++) {
    const index = indices[i];
    if (index === marker) restart = marker;
    else if (index > maximum) maximum = index;
  }
  return buffer.range = {bytes, offset, count, fixedRestart, vertices:maximum+1, restart, indices};
}

export function vertexInput(spec, attribute, buffer, vertices, instances) {
  const bytes=buffer.data;
  const format = formats.get(attribute.type);
  if (!format) return null;
  const [read, size, max] = format;
  const { offset, divisor = 0 } = attribute;
  const stride = attribute.stride || attribute.size * size;
  const last = divisor ? Math.floor((instances - 1) / divisor) : vertices - 1;
  if (offset < 0 || stride < 0 || offset + last * stride + attribute.size * size > bytes.byteLength) return null;
  // A queued draw can borrow a tightly packed static stream. Keep a bounded
  // ratio of backing bytes to queued bytes when drawing a small buffer range.
  const start=bytes.byteOffset+offset;
  const packed=!divisor&&littleEndian&&attribute.type===0x1406&&attribute.size===spec.size&&stride===spec.size*4&&start%4===0;
  if(packed && instances===1 && vertices*spec.size*4>=bytes.byteLength/2){
    buffer.borrowed=true;
    return new Float32Array(bytes.buffer,start,vertices*spec.size);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const data = new Float32Array(vertices * instances * spec.size);
  // Capture values now: later bufferSubData calls may change the binding.
  // With no divisor, each instance consumes the same vertex stream. With a
  // divisor, one source element serves every vertex in a group of instances.
  function readElement(source, dest) {
    const start=offset+stride*source;
    for(let c=0;c<spec.size;c++){
      if(c>=attribute.size)data[dest+c]=Number(c===3);
      else {
        const value=view[read](start+c*size,true);
        data[dest+c]=attribute.normalized&&max?Math.max(-1,value/max):value;
      }
    }
  }
  function repeat(start, length, end) {
    while(start+length<end){
      const copied=Math.min(length,end-start-length);
      data.copyWithin(start+length,start,start+copied);
      length+=copied;
    }
  }
  if(!data.length)return data;
  if(divisor){
    for(let i=0;i<instances;i+=divisor){
      const start=i*vertices*spec.size, end=Math.min(i+divisor,instances)*vertices*spec.size;
      readElement(i/divisor,start);
      repeat(start,spec.size,end);
    }
  }else{
    const length=vertices*spec.size;
    if(packed)
      data.set(new Float32Array(bytes.buffer,start,length));
    else for(let i=0;i<vertices;i++)readElement(i,i*spec.size);
    repeat(0,length,data.length);
  }
  return data;
}

// A matrix uses consecutive attribute locations. Interleaved columns with the
// same divisor form one record, so expand each instance's whole matrix once.
export function matrixInput(spec, attributes, buffers, vertices, instances) {
  const first = attributes.get(spec.location), rows = spec.size / spec.columns;
  if (!first?.enabled || first.type !== 0x1406 || first.size !== rows || !first.stride) return null;
  for (let column=1; column<spec.columns; column++) {
    const next = attributes.get(spec.location+column);
    if (!next?.enabled || next.type !== first.type || next.buffer !== first.buffer ||
        next.size !== rows || next.stride !== first.stride || next.divisor !== first.divisor ||
        next.offset !== first.offset + column*rows*4) return null;
  }
  const buffer = buffers.get(first.buffer);
  return buffer && vertexInput(spec, {...first, size:spec.size}, buffer, vertices, instances);
}

export function triangles(mode, indices, instances, vertices, restart) {
  if (mode === 4 && restart === undefined) {
    const length = indices.length - indices.length % 3;
    const result = new Uint32Array(length * instances);
    for (let instance=0; instance<instances; instance++) {
      const base = instance * vertices, offset = instance * length;
      for (let i=0; i<length; i++) result[offset+i] = indices[i]+base;
    }
    return result;
  }
  const result = [];
  for (let instance = 0; instance < instances; instance++) {
    let length = 0, first, previous, before;
    for (const index of indices) {
      if (index === restart) { length = 0; continue; }
      const next = index + instance * vertices;
      if (length === 0) first = next;
      if (length >= 2) {
        if (mode === 4 && length % 3 === 2) result.push(before, previous, next);
        if (mode === 5) result.push(length % 2 ? previous : before, length % 2 ? before : previous, next);
        if (mode === 6) result.push(first, previous, next);
      }
      before = previous;
      previous = next;
      length++;
    }
  }
  return result;
}
