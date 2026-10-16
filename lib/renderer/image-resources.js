/**
 * Coalesce concurrent requests for the same image within one document. Each
 * consumer gets its own CanvasKit handle, sharing the underlying pixels, so
 * removing one element cannot delete another element's image. Completed
 * requests are dropped; HTTP freshness and persistent caching belong to the
 * controller's network service.
 */
export function imageCrossOrigin(element) {
  const value = element.getAttribute("crossorigin");
  return value === null ? null : value.toLowerCase() === "use-credentials" ? "include" : "same-origin";
}

export function imageRequestKey(src, credentials) {
  return JSON.stringify([src, credentials]);
}

export function createImageResourceLoader(CanvasKit, fetchResource, fetchCors) {
  const documents = new WeakMap();
  const corsRequests = new WeakMap();
  const loadImage = function (document, url, credentials = null) {
    let requests = documents.get(document);
    if (!requests) documents.set(document, requests = new Map());
    const key = imageRequestKey(url, credentials);
    let entry = requests.get(key);
    if (!entry) {
      entry = { consumers: 0, ready: (async () => {
        let response;
        if (credentials !== null) {
          const request = fetchCors({ url, method: "GET", headers: [], body: null,
            mode: "cors", credentials, redirect: "follow" });
          let pending = corsRequests.get(document);
          if (!pending) corsRequests.set(document, pending = new Set());
          pending.add(request);
          try {
            const result = await request;
            const body = result.body instanceof Uint8Array ? result.body : await Bun.readableStreamToBytes(result.body);
            response = { ...result, body };
          } finally { pending.delete(request); }
        } else response = await fetchResource(url, "image");
        if (!(response.ok ?? (response.status >= 200 && response.status < 300))) throw new Error(`HTTP ${response.status}`);
        // Keep Bun's header validation/decompression-size guard before Skia
        // takes ownership of these untrusted encoded bytes.
        const { width, height } = await new Bun.Image(response.body).metadata();
        const image = CanvasKit.MakeImageFromEncoded(response.body);
        if (!image) throw new Error("Image decoding failed");
        return { width, height, image, url: response.url ?? url, requestedURL: url, crossOrigin: credentials,
          originClean: credentials !== null ? true : undefined };
      })() };
      requests.set(key, entry);
    }
    entry.consumers++;
    return entry.ready.then(resource => Object.freeze({ ...resource, image: resource.image.clone() })).finally(() => {
      if (--entry.consumers) return;
      requests.delete(key);
      // All successful consumers already own their clone. Failures have no
      // image to release, and must allow a later request to try again.
      entry.ready.then(resource => resource.image.delete(), () => {});
    });
  };
  loadImage.cancelDocument = (document) => {
    for (const request of corsRequests.get(document) ?? []) request.abort?.();
    corsRequests.delete(document);
  };
  return loadImage;
}
