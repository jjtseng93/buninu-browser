import CSSPropertySetParser from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/parsers/CSSPropertySetParser.ts';
import {normalizeInset} from '../style/inset-values.js';

// The shared declaration manager expands shorthand/pending values before
// these leaves; do not run the vendor's broader sizing grammar afterwards.
for(const name of ['top','right','bottom','left']) {
  CSSPropertySetParser[`get${name[0].toUpperCase()}${name.slice(1)}`]=function(value,important) {
    const normalized=normalizeInset(name,value);
    return normalized===null?null:{[name]:{value:normalized,important}};
  };
}
