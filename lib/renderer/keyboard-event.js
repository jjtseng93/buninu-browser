import {encodingString} from './encoding-string.js';
import {isWindow, registerWindow} from './window-brand.js';

// The deprecated initializer retains the deployed ten-argument signature.
// keyIdentifier is converted but ignored, as in Chromium; key/code and the
// legacy key codes remain those supplied when the event was constructed.
export function installKeyboardEventInterface({global, prototype, read, initialize, unsignedLong}) {
  registerWindow(global);
  const RealmTypeError = global.TypeError;
  const error = (_name, message) => new RealmTypeError(message);
  const eventOf = receiver => {
    const event = read(receiver);
    if (!event) throw error('TypeError', 'Illegal invocation');
    return event;
  };
  const members = {
    get location() { return eventOf(this).location; },
    get isComposing() { return Boolean(eventOf(this).isComposing); },
    initKeyboardEvent(type, bubbles = false, cancelable = false, view = null,
      keyIdentifier = '', location = 0, ctrlKey = false, altKey = false, shiftKey = false, metaKey = false) {
      eventOf(this);
      if (!arguments.length) throw error('TypeError', 'initKeyboardEvent requires a type');
      type = encodingString(type, error);
      if (view !== null && !isWindow(view)) throw error('TypeError', 'view must be a Window or null');
      encodingString(keyIdentifier, error);
      location = unsignedLong(location);
      // Convert every argument before the implementation's dispatch guard.
      initialize(this, {type, bubbles:Boolean(bubbles), cancelable:Boolean(cancelable), view, location,
        ctrlKey:Boolean(ctrlKey), altKey:Boolean(altKey), shiftKey:Boolean(shiftKey), metaKey:Boolean(metaKey)});
    },
  };
  for (const name of Reflect.ownKeys(members))
    Object.defineProperty(prototype, name, {...Object.getOwnPropertyDescriptor(members, name), enumerable:true});
  for (const [name, value] of Object.entries({DOM_KEY_LOCATION_STANDARD:0, DOM_KEY_LOCATION_LEFT:1,
    DOM_KEY_LOCATION_RIGHT:2, DOM_KEY_LOCATION_NUMPAD:3})) {
    Object.defineProperty(prototype, name, {value, enumerable:true});
    Object.defineProperty(prototype.constructor, name, {value, enumerable:true});
  }
}
