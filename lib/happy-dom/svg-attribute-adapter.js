import HTMLParser from "../../vendor/happy-dom/packages/happy-dom/src/html-parser/HTMLParser.ts";

// HTML tokenization ASCII-lowercases every attribute, including foreign
// content. Tree construction then restores the standard SVG spellings.
// https://html.spec.whatwg.org/multipage/parsing.html#adjust-svg-attributes
const adjustedNames = new Map(`attributeName attributeType baseFrequency baseProfile calcMode clipPathUnits
  diffuseConstant edgeMode filterUnits glyphRef gradientTransform gradientUnits kernelMatrix kernelUnitLength
  keyPoints keySplines keyTimes lengthAdjust limitingConeAngle markerHeight markerUnits markerWidth
  maskContentUnits maskUnits numOctaves pathLength patternContentUnits patternTransform patternUnits
  pointsAtX pointsAtY pointsAtZ preserveAlpha preserveAspectRatio primitiveUnits refX refY repeatCount repeatDur
  requiredExtensions requiredFeatures specularConstant specularExponent spreadMethod startOffset stdDeviation
  stitchTiles surfaceScale systemLanguage tableValues targetX targetY textLength viewBox viewTarget
  xChannelSelector yChannelSelector zoomAndPan`.trim().split(/\s+/).map(name => [name.toLowerCase(), name]));
const space = character => character === " " || character === "\t" || character === "\n" || character === "\r" || character === "\f";

function adjustNames(source) {
  let index = 0, copied = 0, output = "";
  while (index < source.length) {
    while (space(source[index]) || source[index] === "/") index++;
    const start = index;
    while (index < source.length && !space(source[index]) && source[index] !== "=" && source[index] !== "/" && source[index] !== ">") index++;
    if (index === start) { index++; continue; }
    const name = source.slice(start, index);
    const lower = name.replace(/[A-Z]/g, character => character.toLowerCase());
    const adjusted = adjustedNames.get(lower) ?? lower;
    if (name !== adjusted) {
      output += source.slice(copied, start) + adjusted;
      copied = index;
    }
    while (space(source[index])) index++;
    if (source[index] !== "=") continue;
    index++;
    while (space(source[index])) index++;
    const quote = source[index];
    if (quote === '"' || quote === "'") {
      index++;
      while (index < source.length && source[index] !== quote) index++;
      if (index < source.length) index++;
    } else {
      while (index < source.length && !space(source[index]) && source[index] !== ">") index++;
    }
  }
  return copied ? output + source.slice(copied) : source;
}

const parseAttributes = HTMLParser.prototype.parseEndOfStartTag;
HTMLParser.prototype.parseEndOfStartTag = function (source, selfClosing) {
  if (source && this.nextElement?.namespaceURI === "http://www.w3.org/2000/svg") source = adjustNames(source);
  return parseAttributes.call(this, source, selfClosing);
};
