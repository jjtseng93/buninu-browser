/** Shared CLI viewport parsing for persistent headless and screenshot modes. */
export function parseWindowSize(args) {
  const value = args.find(arg => arg.startsWith('--window-size='))?.slice('--window-size='.length);
  if (value === undefined) return {width: 800, height: 600};
  const match = value.match(/^(\d+)[,x](\d+)$/i);
  const width = Number(match?.[1]), height = Number(match?.[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    throw new Error('--window-size must be WIDTH,HEIGHT with positive integers');
  return {width, height};
}
