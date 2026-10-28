// Decoding must not block screenshot composition (or vice versa). Initialise
// WASM before the compositor announces readiness and seccomp is installed.
import wasmpeg from '../../vendor/wasmpeg/src/js/index.js';
import { VideoPresentation } from './video-presentation.js';

// The decoder can keep advancing while the compositor is busy. Bound pixels
// waiting across the Worker boundary to one transmitted and one latest frame.
// Keep an outstanding delivery across stop/open: its ACK must be received
// before another generation can send, and cannot acknowledge a newer frame.
let inFlight = null, pending = null, nextDelivery = 0;
function sendLatest() {
  if (inFlight || !pending) return;
  const {id, frame} = pending;
  pending = null;
  if (video.config?.id !== id) return;
  const delivery = ++nextDelivery;
  inFlight = {id, delivery};
  try { postMessage({ type: 'frame', id, delivery, frame }, [frame.pixels.buffer]); }
  catch (error) { inFlight = null; throw error; }
}

const video = new VideoPresentation(wasmpeg, () => {
  pending = {id:video.config.id, frame:video.frame};
  sendLatest();
}, report => postMessage({ type: 'report', report }));

self.onmessage = ({data}) => {
  switch (data.type) {
    case 'open': pending = null; void video.open(data.config); break;
    case 'extend': void video.extend(data); break;
    case 'stop':
      if (data.id === undefined || video.config?.id === data.id) pending = null;
      video.stop(data.id);
      break;
    case 'frame-ack':
      if (inFlight?.id === data.id && inFlight.delivery === data.delivery) {
        inFlight = null;
        sendLatest();
      }
      break;
    case 'bind': video.bind(data.id, data.audioId, data.audioStart, data.time, data.endTime); break;
    case 'timing': video.timing(data.id, data.seconds); break;
  }
};
await wasmpeg.load();
postMessage({ type: 'ready' });
