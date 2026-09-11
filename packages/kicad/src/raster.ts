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
