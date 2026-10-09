/**
 * Trusted Types (W3C Trusted Types §2–§3): window.trustedTypes, the
 * TrustedTypePolicyFactory that makes named policies, and the TrustedHTML,
 * TrustedScript and TrustedScriptURL values a policy returns.
 *
 * Nothing is enforced: no Content-Security-Policy turns on
 * `require-trusted-types-for`, so every sink still accepts strings, and a
 * trusted value reaching a sink is used through its string value (its
 * toString). What pages see is the API, which they feature-detect and use
 * as in Chromium, and eval() of a TrustedScript, which runs its text
 * (HostGetCodeForEval) where any other non-string is returned unchanged.
 */
import { platformObject } from "./interfaces.js";

const TRUSTED_KINDS = [
  ["TrustedHTML", "createHTML"],
  ["TrustedScript", "createScript"],
  ["TrustedScriptURL", "createScriptURL"],
];

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * @param {object} [parent] the page's Object.prototype
 * @returns {{ interfaces: Record<string, Function>, trustedTypes: object, scriptText: (value: unknown) => string | undefined }}
 */
export function trustedTypesApi(parent = Object.prototype) {
  /** @type {Record<string, { made: ReturnType<typeof platformObject>, values: WeakMap<object, string> }>} */
  const kinds = {};
  for (const [name] of TRUSTED_KINDS) {
    const values = new WeakMap();
    const made = platformObject(name, {
      toString() { return this.value; },
      toJSON() { return this.value; },
    }, { parent });
    kinds[name] = { made, values };
  }
  const trusted = (name, value) => {
    const kind = kinds[name];
    const object = kind.made.create({ value });
    kind.values.set(object, value);
    return object;
  };
  const isKind = (name, value) => value !== null && typeof value === "object" && kinds[name].values.has(value);

  let defaultPolicy = null;
  const policyMembers = { get name() { return this.name; } };
  for (const [kind, method] of TRUSTED_KINDS) {
    // Create a Trusted Type (§4.3.1): the policy's callback turns the input
    // into the value's text; null or undefined become the empty string.
    policyMembers[method] = function (input, ...args) {
      const callback = this.options[method];
      if (typeof callback !== "function") {
        throw new TypeError(`Failed to execute '${method}' on 'TrustedTypePolicy': Policy ${this.name}'s TrustedTypePolicyOptions did not specify a '${method}' member.`);
      }
      const result = Reflect.apply(callback, undefined, [String(input), ...args]);
      return trusted(kind, result === null || result === undefined ? "" : String(result));
    };
  }
  const Policy = platformObject("TrustedTypePolicy", policyMembers, { parent });

  const Factory = platformObject("TrustedTypePolicyFactory", {
    createPolicy(name, options = {}) {
      const policyName = String(name);
      const callbacks = {};
      for (const [, method] of TRUSTED_KINDS) {
        const callback = options?.[method];
        if (callback !== undefined && callback !== null) {
          if (typeof callback !== "function") {
            throw new TypeError(`Failed to execute 'createPolicy' on 'TrustedTypePolicyFactory': The '${method}' property of the dictionary is not a function.`);
          }
          callbacks[method] = callback;
        }
      }
      if (policyName === "default" && defaultPolicy) {
        throw new TypeError("Failed to execute 'createPolicy' on 'TrustedTypePolicyFactory': Policy with name \"default\" already exists.");
      }
      const policy = Policy.create({ name: policyName, options: callbacks });
      if (policyName === "default") defaultPolicy = policy;
      return policy;
    },
    isHTML(value) { return isKind("TrustedHTML", value); },
    isScript(value) { return isKind("TrustedScript", value); },
    isScriptURL(value) { return isKind("TrustedScriptURL", value); },
    get emptyHTML() { return trusted("TrustedHTML", ""); },
    get emptyScript() { return trusted("TrustedScript", ""); },
    // The sinks that would require a trusted type (§4.2.4 and §4.2.5).
    getAttributeType(tagName, attribute, elementNs = "", attrNs = "") {
      const tag = String(tagName).toLowerCase();
      const name = String(attribute).toLowerCase();
      const namespace = elementNs === null || elementNs === "" ? HTML_NAMESPACE : String(elementNs);
      if (attrNs !== null && attrNs !== "") return null;
      if (name.startsWith("on")) return "TrustedScript";
      if (namespace === HTML_NAMESPACE) {
        if (tag === "iframe" && name === "srcdoc") return "TrustedHTML";
        if (tag === "script" && name === "src") return "TrustedScriptURL";
      }
      if (namespace === SVG_NAMESPACE && tag === "script" && name === "href") return "TrustedScriptURL";
      return null;
    },
    getPropertyType(tagName, property, elementNs = "") {
      const tag = String(tagName).toLowerCase();
      const name = String(property);
      const namespace = elementNs === null || elementNs === "" ? HTML_NAMESPACE : String(elementNs);
      if (name === "innerHTML" || name === "outerHTML") return "TrustedHTML";
      if (namespace === HTML_NAMESPACE && tag === "iframe" && name === "srcdoc") return "TrustedHTML";
      if (namespace === HTML_NAMESPACE && tag === "script") {
        if (name === "src") return "TrustedScriptURL";
        if (name === "innerText" || name === "textContent" || name === "text") return "TrustedScript";
      }
      return null;
    },
    get defaultPolicy() { return defaultPolicy; },
  }, { parent });

  return {
    interfaces: {
      TrustedHTML: kinds.TrustedHTML.made.Interface,
      TrustedScript: kinds.TrustedScript.made.Interface,
      TrustedScriptURL: kinds.TrustedScriptURL.made.Interface,
      TrustedTypePolicy: Policy.Interface,
      TrustedTypePolicyFactory: Factory.Interface,
    },
    trustedTypes: Factory.instance,
    /** The text eval() runs for `value`: a TrustedScript's, or undefined for anything else. */
    scriptText: (value) => (isKind("TrustedScript", value) ? kinds.TrustedScript.values.get(value) : undefined),
  };
}
