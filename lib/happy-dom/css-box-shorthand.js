import CSSPropertyGetParser from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/parsers/CSSPropertyGetParser.ts';

// A shorthand has one priority. Combining sides with unequal priorities would
// lose their cascade behavior when CSSOM writes the serialized declaration back.
// Keep the vendor's value compression and CSS-wide keyword checks unchanged.
for (const name of ['Margin', 'Padding']) {
  const get = CSSPropertyGetParser[`get${name}`];
  const fields = ['top', 'right', 'bottom', 'left'].map(side => `${name.toLowerCase()}-${side}`);
  CSSPropertyGetParser[`get${name}`] = function(properties) {
    const parts = fields.map(field => properties[field]);
    if (parts.some(part => !part || Boolean(part.important) !== Boolean(parts[0]?.important))) return null;
    return get.call(this, properties);
  };
}
