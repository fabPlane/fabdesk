export type RasterSize = { width: number; height: number };

// Bound each backing store (32 MiB RGBA) and avoid reallocating for every resized pixel.
export function svgRasterSize(width: number, height: number, dpr: number): RasterSize {
  const ratio = height / width;
  const wanted = Math.ceil(Math.max(1, width * Math.max(1, dpr)) / 256) * 256;
  const capped = Math.min(wanted, 4096, 4096 / ratio, Math.sqrt(8 * 1024 * 1024 / ratio));
  return { width: Math.max(1, Math.floor(capped)), height: Math.max(1, Math.floor(capped * ratio)) };
}

/** Cache by stable image URL; consumers copy pixels synchronously before eviction. */
export function createSvgRasterCache<T extends RasterSize>(
  dispose: (raster: T) => void,
  maxBytes = 48 * 1024 * 1024,
) {
  const entries = new Map<string, T>();
  let bytes = 0;
  const remove = (source: string, raster: T) => {
    entries.delete(source);
    bytes -= raster.width * raster.height * 4;
    dispose(raster);
  };
  return {
    get(source: string, size: RasterSize, render: () => T): T {
      let raster = entries.get(source);
      if (!raster || raster.width < size.width || raster.height < size.height) {
        const next = render(); // A failed render must not replace a usable cached preview.
        if (raster) remove(source, raster);
        raster = next;
        bytes += raster.width * raster.height * 4;
      }
      entries.delete(source);
      entries.set(source, raster);
      for (const [key, value] of entries) {
        if (bytes <= maxBytes || entries.size === 1) break;
        remove(key, value);
      }
      return raster;
    },
  };
}

export const svgRasterCache = createSvgRasterCache<HTMLCanvasElement>(canvas => {
  canvas.width = 0;
  canvas.height = 0;
});
