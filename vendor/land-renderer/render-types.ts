// Structural types for the JS compositor/worker boundary; no runtime imports.
export interface Pixels { bytes: Uint8Array; width: number; height: number; stride: number; format: number }
export interface ViewportSurface {
  pixels: Pixels | null; scale: number; transform: number;
  viewportSource?: number[] | null; viewportDestination?: number[] | null;
}
export type RawFormat = 'rgba' | 'bgra';
