// CSS names and legacy CSSOM spellings for properties implemented by the renderer.
const aliases = new Map();
export const webkitStyleNames = new Map();
for (const property of ['transition-duration', 'transition-delay', 'transition-timing-function', 'text-size-adjust', 'filter', 'backdrop-filter', 'appearance', 'transform', 'transform-origin', 'transform-style', 'backface-visibility', 'box-shadow', 'border-radius',
  'background-clip', 'user-select', 'flex', 'flex-basis', 'flex-grow', 'flex-shrink',
  'flex-direction', 'flex-flow', 'flex-wrap', 'align-items', 'align-self',
  'align-content', 'justify-content', 'order', 'animation', 'animation-name',
  'animation-duration', 'animation-delay', 'animation-direction', 'animation-fill-mode',
  'animation-iteration-count', 'animation-play-state', 'animation-timing-function',
  '-webkit-text-stroke', '-webkit-text-stroke-width', '-webkit-text-stroke-color', '-webkit-text-fill-color', '-webkit-line-clamp', '-webkit-box-orient']) {
  const css = property.startsWith('-webkit-') ? property : '-webkit-' + property;
  aliases.set(css, property);
  const idl = css.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  for (const name of [css, idl, 'w' + idl.slice(1)]) webkitStyleNames.set(name, property);
}

export function canonicalCssProperty(name) {
  return name.startsWith('-') && !name.startsWith('--') ? aliases.get(name.toLowerCase()) ?? name : name;
}
