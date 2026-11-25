import { Resvg, initWasm } from "@resvg/resvg-wasm";
// @ts-expect-error Bun resolves and embeds WASM imports marked as files.
import wasmPath from "@resvg/resvg-wasm/index_bg.wasm" with { type: "file" };

let initialization: Promise<void> | undefined;

async function ready(): Promise<void> {
  initialization ??= Bun.file(wasmPath)
    .arrayBuffer()
    .then((bytes) => initWasm(bytes));
  await initialization;
}

/** The native exporter returned no usable SVG, rather than a framing/runtime fault. */
export class SchematicPreviewUnavailableError extends Error {
  constructor() {
    super("KiCad did not produce a usable schematic SVG preview.");
    this.name = "SchematicPreviewUnavailableError";
  }
}

/** Presentation-only crop of a frame-free native schematic. Geometry stays in native SVG units. */
export async function frameSchematicCircuit(svg: string): Promise<string> {
  if (svg.length > 24_000_000) throw new Error("The schematic preview exceeds the 24,000,000 character framing limit");
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!root) throw new SchematicPreviewUnavailableError();
  const box = /\bviewBox="([^"]+)"/.exec(root)?.[1]?.trim().split(/\s+/).map(Number);
  const width = Number(/\bwidth="([\d.]+)mm"/.exec(root)?.[1]), height = Number(/\bheight="([\d.]+)mm"/.exec(root)?.[1]);
  if (!box || box.length !== 4 || box[0] !== 0 || box[1] !== 0 || ![width, height, ...box].every(Number.isFinite) || Math.abs(width - box[2]!) > .05 || Math.abs(height - box[3]!) > .05) throw new Error("Schematic framing requires the native millimetre page coordinate system");
  await ready();
  const renderer = new Resvg(svg);
  try {
    const bounds = renderer.innerBBox();
    try {
      if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return svg.replace(root, root.replace(/>$/, ' data-fabplane-schematic-view="circuit-empty">'));
      const margin = 4, x = bounds.x - margin, y = bounds.y - margin, w = bounds.width + margin * 2, h = bounds.height + margin * 2;
      const framed = root.replace(/\bwidth="[^"]+"/, `width="${w}mm"`).replace(/\bheight="[^"]+"/, `height="${h}mm"`).replace(/\bviewBox="[^"]+"/, `viewBox="${x} ${y} ${w} ${h}"`).replace(/>$/, ' data-fabplane-schematic-view="circuit">');
      return svg.replace(root, framed);
    } finally { bounds?.free(); }
  } finally { renderer.free(); }
}

export type RasterizedSvg = {
  png: Uint8Array;
  width: number;
  height: number;
};

/** Convert SVG markup into real PNG pixels without relying on a host graphics program. */
export async function rasterizeSvg(
  svg: string | Uint8Array,
  options: { maxWidth?: number; background?: string } = {},
): Promise<RasterizedSvg> {
  await ready();
  const renderer = new Resvg(svg, {
    background: options.background ?? "white",
    ...(options.maxWidth ? { fitTo: { mode: "width", value: options.maxWidth } } : {}),
  });
  try {
    const image = renderer.render();
    try {
      return { png: image.asPng(), width: image.width, height: image.height };
    } finally {
      image.free();
    }
  } finally {
    renderer.free();
  }
}

/** Rasterize SVG markup to raw RGBA pixels at an exact pixel width (height follows the aspect ratio). */
export async function rasterizeSvgPixels(
  svg: string | Uint8Array,
  options: { width: number; background?: string },
): Promise<{ rgba: Uint8Array; width: number; height: number }> {
  await ready();
  const renderer = new Resvg(svg, { background: options.background ?? "white", fitTo: { mode: "width", value: options.width } });
  try {
    const image = renderer.render();
    try {
      return { rgba: new Uint8Array(image.pixels), width: image.width, height: image.height };
    } finally {
      image.free();
    }
  } finally {
    renderer.free();
  }
}
