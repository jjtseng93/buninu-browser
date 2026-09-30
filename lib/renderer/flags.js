/** Command-line flags the controller passes to renderer processes. */
import { CHROMIUM_VERSION } from "../user-agent.js";

/** fd 3 is the controller's compositor channel; start the compositor Worker. */
export const COMPOSITOR_FLAG = "--compositor";

/** --mobile: the renderer presents itself as a phone (user agent, touch media features). */
export const MOBILE_FLAG = "--buninu-mobile";

/** Chrome for Android on an Android 16 phone, as sent with --mobile. */
export const MOBILE_USER_AGENT =
  `Mozilla/5.0 (Linux; Android 16; ASUSAI2501C Build/BQ2A.250525.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_VERSION} Mobile Safari/537.36`;

/**
 * --mobile lays pages out no wider than a phone (CSS pixels; a Pixel-class
 * phone is 412 wide) and scales them up to fill the client's viewport.
 */
export const MOBILE_LAYOUT_WIDTH = 412;
