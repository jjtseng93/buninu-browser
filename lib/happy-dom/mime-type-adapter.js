/**
 * The narrow whatwg-mimetype surface currently used by Happy DOM FileReader.
 */
export default class MIMEType {
  #value;

  constructor(value) {
    const essence = String(value).split(";", 1)[0].trim().toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/.test(essence)) {
      throw new TypeError(`Invalid MIME type: ${value}`);
    }
    this.#value = essence;
  }

  static parse(value) {
    try {
      return new MIMEType(value);
    } catch {
      return null;
    }
  }

  toString() {
    return this.#value;
  }
}

