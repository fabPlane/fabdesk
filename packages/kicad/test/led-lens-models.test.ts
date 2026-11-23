import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledLensModels } from "../src/led-lens-models";
import { rewriteModelPaths } from "../src/model-board";

test("stock indicators get per-value lens variants, preserving leads, placement, and custom models", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fabdesk-led-test-"));
  try {
    const original = join(dir, "original.step");
    const lens = "COLOUR_RGB('',0.699999988079,0.10000000149,5.000000074506E-002)";
    const metal = "COLOUR_RGB('',0.824000000954,0.819999992847,0.78100001812)";
    const step = `#454 = ${lens};\n#497 = ${metal};\n`;
    await writeFile(original, step);
    const stock = "${KICAD9_3DMODEL_DIR}/LED_THT.3dshapes/LED_D5.0mm.step";
    const footprint = (ref: string, value: string, model = stock) =>
      `(footprint "Indicator" (property "Reference" "${ref}") (model "${model}" (offset (xyz 1 2 3))) (property "Value" "${value}"))`;
    const pcb = `(kicad_pcb ${[footprint("D7", "RED"), footprint("D8", "green"), footprint("D9", "AMBER"), footprint("D10", "LED_BLUE"), footprint("D108", "green"), footprint("D11", "RED/GREEN"), footprint("D12", "GREEN", "${KIPRJMOD}/custom.step")].join(" ")})`;
    const variants = await ledLensModels(pcb, dir, () => original);
    expect([...variants.keys()]).toEqual([0, 1, 2, 3, 4]);
    expect(variants.get(1)?.path).toBe(variants.get(4)?.path);
    for (const [index, rgb] of ["0.70,0.10,0.05", "0.06,0.69,0.19", "1.0,0.63,0.03", "0.06,0.31,0.90"].entries()) {
      expect(await readFile(variants.get(index)!.path, "utf8")).toBe(step.replace(lens, `COLOUR_RGB('',${rgb})`));
    }
    const rewritten = rewriteModelPaths(pcb, () => null, variants);
    expect(rewritten).toContain(variants.get(3)!.path.replaceAll("\\", "/"));
    expect(rewritten.match(/\(offset \(xyz 1 2 3\)\)/g)).toHaveLength(7);
    expect(rewritten).toContain('"${KIPRJMOD}/custom.step"');
    expect(await readFile(original, "utf8")).toBe(step);
    await writeFile(original, metal);
    expect((await ledLensModels(pcb, dir, () => original)).size).toBe(0);

    const smd = "${KICAD9_3DMODEL_DIR}/LED_SMD.3dshapes/LED_0805_2012Metric.wrl";
    const smdLens = "COLOUR_RGB('',0.894999980927,0.89099997282,0.813000023365)";
    const underside = "COLOUR_RGB('',0.34,0.68,0.445)";
    const smdStep = `#381 = ${smdLens};\n#394 = ${metal};\n#402 = ${underside};\n`;
    await writeFile(original, smdStep);
    const smdVariants = await ledLensModels(`(kicad_pcb ${footprint("D4", "GREEN", smd)})`, dir, () => original);
    expect(await readFile(smdVariants.get(0)!.path, "utf8")).toBe(smdStep.replace(smdLens, "COLOUR_RGB('',0.06,0.69,0.19)"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
