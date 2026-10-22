export const QML_MIME = 'text/x-qml';
export function isQmlDocument(url, contentType = '') {
  const mime = contentType.split(';')[0].trim().toLowerCase();
  if (['text/x-qml', 'application/x-qml'].includes(mime)) return true;
  // An explicit HTML response must retain HTML behavior, even at a .qml URL.
  return ['', 'text/plain', 'application/octet-stream'].includes(mime)
    && /\.qml$/i.test(new URL(url, 'file:///').pathname);
}

