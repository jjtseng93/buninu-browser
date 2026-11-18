// Web Audio equal-power panning in the listener's horizontal plane.
// Parameter arrays are sampled on the same timeline as gain and oscillator automation.
export function panQuantum(input, source, listener, settings, frames) {
  const output = new Float32Array(frames * 2);
  const stereo = input.length === frames * 2 && settings.channelCount !== 1;
  for (let i = 0; i < frames; i++) {
    const dx = source.positionX[i] - listener.positionX[i];
    const dy = source.positionY[i] - listener.positionY[i];
    const dz = source.positionZ[i] - listener.positionZ[i];
    const distance = Math.hypot(dx, dy, dz);
    const fx = listener.forwardX[i], fy = listener.forwardY[i], fz = listener.forwardZ[i];
    const ux = listener.upX[i], uy = listener.upY[i], uz = listener.upZ[i];
    const rx = fy * uz - fz * uy, ry = fz * ux - fx * uz, rz = fx * uy - fy * ux;
    const right = (dx * rx + dy * ry + dz * rz) / (Math.hypot(rx, ry, rz) || 1);
    const forward = (dx * fx + dy * fy + dz * fz) / (Math.hypot(fx, fy, fz) || 1);
    const pan = Math.atan2(right, Math.abs(forward)) * 2 / Math.PI;
    const {refDistance:ref, maxDistance:max, rolloffFactor:rolloff} = settings;
    let gain = 1;
    if (settings.distanceModel === 'linear') {
      if (max !== ref) gain = 1 - rolloff * (Math.min(Math.max(distance,ref),max) - ref) / (max - ref);
    } else if (distance > ref && rolloff > 0) {
      gain = settings.distanceModel === 'inverse' ? ref / (ref + rolloff * (distance - ref))
        : Math.pow(distance / ref, -rolloff);
    }
    gain = Math.min(1,Math.max(0,gain));
    const ox=source.orientationX[i], oy=source.orientationY[i], oz=source.orientationZ[i];
    const length=Math.hypot(ox,oy,oz);
    if (distance && length && (settings.coneInnerAngle !== 360 || settings.coneOuterAngle !== 360)) {
      const cosine = -(dx*ox + dy*oy + dz*oz)/(distance*length);
      const angle = Math.acos(Math.max(-1, Math.min(1,cosine))) * 180 / Math.PI;
      const inner = Math.abs(settings.coneInnerAngle)/2, outer = Math.abs(settings.coneOuterAngle)/2;
      if (angle > inner) gain *= angle >= outer ? settings.coneOuterGain
        : 1 + (settings.coneOuterGain - 1) * (angle - inner)/(outer - inner);
    }
    const left = input[i], rightSample = input[i+frames];
    if (stereo) {
      const theta = (pan <= 0 ? pan + 1 : pan) * Math.PI/2;
      output[i] = gain * (pan <= 0 ? left + rightSample*Math.cos(theta) : left*Math.cos(theta));
      output[i+frames] = gain * (pan <= 0 ? rightSample*Math.sin(theta) : rightSample + left*Math.sin(theta));
    } else {
      const value = gain * (input.length === frames ? left : (left+rightSample)/2);
      const theta = (pan+1)*Math.PI/4;
      output[i] = value*Math.cos(theta);
      output[i+frames] = value*Math.sin(theta);
    }
  }
  return output;
}
