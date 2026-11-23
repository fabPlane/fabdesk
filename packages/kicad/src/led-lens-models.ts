import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readSavedBoardModels } from "./mechanical";
import type { ModelVariants } from "./model-board";

// sRGB diffuse colors for unpowered, tinted indicator lenses.
const colors = new Map<string, string>(Object.entries({
  red: "0.70,0.10,0.05", green: "0.06,0.69,0.19", amber: "1.0,0.63,0.03",
  blue: "0.06,0.31,0.90", yellow: "0.95,0.85,0.04", orange: "0.98,0.38,0.03",
  white: "0.94,0.94,0.91", violet: "0.52,0.15,0.85",
}));
// Match the lens color used by these single-color KiCad stock families. Their
// terminals (and the SMD underside) have separate STEP color definitions.
const stockModel = /^\$(?:\{KICAD\d*_3DMODEL_DIR\}|\(KICAD\d*_3DMODEL_DIR\)|\{KISYS3DMOD\})\/(LED_THT\.3dshapes\/LED_D\d+(?:\.\d+)?mm|LED_SMD\.3dshapes\/LED_\d{4}_\d{4}Metric)\.(?:step|stp|wrl)$/i;

export async function ledLensModels(text: string, scratch: string, resolvePath: (declared: string) => string | null): Promise<ModelVariants> {
  const variants = new Map<number, { declared: string; path: string }>();
  if (!/LED_(?:THT|SMD)\.3dshapes\/LED_/i.test(text)) return variants;
  const prepared = new Map<string, string | null>();
  for (const [index, footprint] of readSavedBoardModels(text).entries()) {
    const value = footprint.value?.trim().toLowerCase().replace(/^led[\s_-]+|[\s_-]+led$/g, "");
    const rgb = colors.get(value ?? "");
    const visible = footprint.models.filter(model => !model.hidden);
    if (!rgb || visible.length !== 1 || footprint.dnp) continue;
    const declared = visible[0]!.declared;
    const family = stockModel.exec(declared)?.[1];
    if (!family) continue;
    const source = resolvePath(declared);
    if (!source || !/\.st(?:ep|p)$/i.test(source)) continue;
    const key = JSON.stringify([source, family, rgb]);
    if (!prepared.has(key)) {
      const step = await readFile(source, "latin1").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      const throughHole = /^LED_THT\./i.test(family);
      const lens = throughHole ? [.7, .1, .05] : [.895, .891, .813];
      const tinted = step.replace(/COLOUR_RGB\(\s*''\s*,\s*([\d.eE+-]+)\s*,\s*([\d.eE+-]+)\s*,\s*([\d.eE+-]+)\s*\)/g,
        (original, r: string, g: string, b: string) =>
          [r, g, b].every((v, i) => Math.abs(Number(v) - lens[i]!) < 0.00001) ? `COLOUR_RGB('',${rgb})` : original);
      let path: string | null = null;
      if (tinted !== step) {
        path = join(scratch, `${family.split("/").pop()}-${value}-${prepared.size}.step`);
        await writeFile(path, tinted, "latin1");
      }
      prepared.set(key, path);
    }
    const path = prepared.get(key);
    if (path) variants.set(index, { declared, path });
  }
  return variants;
}
