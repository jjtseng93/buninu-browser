import CSSPropertySetParser from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/parsers/CSSPropertySetParser.ts';
import {normalizeMargin} from '../style/margin-values.js';

// The shared declaration manager expands shorthands and retains pending
// sources. These leaf parsers must not reject already-validated CSS math.
for(const side of ['top','right','bottom','left']) {
  const name=`margin-${side}`,method=`getMargin${side[0].toUpperCase()}${side.slice(1)}`;
  CSSPropertySetParser[method]=function(value,important) {
    const normalized=normalizeMargin(name,value);
    return normalized===null?null:{[name]:{value:normalized,important}};
  };
}
