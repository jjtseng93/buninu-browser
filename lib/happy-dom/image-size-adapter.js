/**
 * Async replacement for buffer-image-size using Bun's built-in image decoder.
 */
export default async function imageSize(buffer) {
  const { width, height } = await new Bun.Image(buffer).metadata();
  return { width, height };
}

