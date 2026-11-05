// Fetch's HTTP token, method normalization and forbidden request-header rules.
// Shared by the page API and the controller, which still validates all IPC input.
export const isHTTPToken = value => value.length > 0 && !/[^!#$%&'*+.^_`|~0-9A-Za-z-]/.test(value);
const normalizedMethods = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT']);
export const isForbiddenMethod = value => /^(CONNECT|TRACE|TRACK)$/i.test(value);
export function normalizeMethod(value) {
  if (!isHTTPToken(value)) return value;
  const upper = value.toUpperCase();
  return normalizedMethods.has(upper) ? upper : value;
}
export const normalizeHeaderValue = value => value.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
export const isHeaderValue = value => !/[\0\r\n]/.test(value);

const forbiddenNames = new Set([
  'accept-charset', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method',
  'connection', 'content-length', 'cookie', 'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive',
  'origin', 'referer', 'set-cookie', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'via',
]);
export function isForbiddenRequestHeader(name, value) {
  name = name.toLowerCase();
  if (forbiddenNames.has(name) || name.startsWith('proxy-') || name.startsWith('sec-')) return true;
  if (!['x-http-method', 'x-http-method-override', 'x-method-override'].includes(name)) return false;
  // Split on commas outside quoted strings. Quotes stay part of the value:
  // a quoted "TRACE" is not the forbidden method token TRACE.
  let start = 0, quoted = false;
  for (let i = 0; i <= value.length; i++) {
    if (quoted && value[i] === '\\') { i++; continue; }
    if (value[i] === '"') quoted = !quoted;
    if (i === value.length || !quoted && value[i] === ',') {
      if (isForbiddenMethod(normalizeHeaderValue(value.slice(start, i)))) return true;
      start = i + 1;
    }
  }
  return false;
}
