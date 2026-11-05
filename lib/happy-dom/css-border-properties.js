import CSSPropertySetParser from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/parsers/CSSPropertySetParser.ts';
import {normalizeBorderValue} from '../style/border-values.js';
import {parseCSSComponentValues} from '../style/css-value-tokens.js';

// All border shorthands call these same parsers. Validate before expansion so
// a fifth side or a second width cannot silently overwrite a valid border.
for(const side of ['', '-top','-right','-bottom','-left'])for(const kind of ['', '-width','-style','-color']) {
  const name=`border${side}${kind}`,method=`get${name.replace(/(^|-)([a-z])/g,(_,dash,c)=>c.toUpperCase())}`;
  const original=CSSPropertySetParser[method];
  CSSPropertySetParser[method]=function(value,important) {
    const normalized=normalizeBorderValue(name,value);
    if(normalized===null)return null;
    // Keep pending substitutions as the original declaration, as the vendor
    // already does for lowercase var(). Expanding a pending shorthand through
    // its width/style/color parsers would duplicate it before substitution.
    if(parseCSSComponentValues(normalized)?.pending)return {[name]:{value:normalized,important}};
    // Preserve the vendor's color/shorthand serialization and reset behavior.
    // Valid math and pending substitutions must survive its older subparsers.
    return original.call(this,normalized,important)??{[name]:{value:normalized,important}};
  };
}
