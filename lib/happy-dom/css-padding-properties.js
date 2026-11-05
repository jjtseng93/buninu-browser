import CSSPropertySetParser from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/parsers/CSSPropertySetParser.ts';
import {normalizePadding} from '../style/padding-values.js';

// The shared manager owns shorthand expansion/priority/pending metadata.
// Leaf parsers must keep already-validated math and non-ASCII variables.
for(const side of ['top','right','bottom','left']) {
  const name=`padding-${side}`,method=`getPadding${side[0].toUpperCase()}${side.slice(1)}`;
  CSSPropertySetParser[method]=function(value,important) {
    const normalized=normalizePadding(name,value);
    return normalized===null?null:{[name]:{value:normalized,important}};
  };
}
