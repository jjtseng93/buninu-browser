// CSSOM legacy sRGB serialization. Keep the renderer's internal colors intact;
// only values exposed through getComputedStyle use this representation.
export function serializeComputedColor(value) {
  const match = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(value ?? '');
  if (!match) return value;
  const channels = `${match[1]}, ${match[2]}, ${match[3]}`;
  const alpha = Math.max(0, Math.min(255, Math.round(Number(match[4]) * 255)));
  if (alpha === 255) return `rgb(${channels})`;
  // CSSOM's <alphavalue> algorithm: use two decimals if they round-trip to
  // the stored byte, otherwise three. Bun.color stores legacy alpha in 8 bits.
  const short = Math.round(alpha * 100 / 255) / 100;
  const serialized = Math.round(short * 255) === alpha ? short : Math.round(alpha * 1000 / 255) / 1000;
  return `rgba(${channels}, ${serialized})`;
}
