export const RENDER_INTERVAL_FLAG = "--buninu-render-min-interval=";

// Validate in the controller, then pass only this number to the sandboxed child.
export function renderMinInterval(value, warn = console.warn) {
  if (value === undefined) return 16;
  if (/^\d+$/.test(value) && Number(value) <= 60000) return Number(value);
  warn("buninu-browser: BUNINU_RENDER_MIN_INTERVAL must be an integer from 0 to 60000 ms; using 16 ms");
  return 16;
}
