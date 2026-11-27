/**
 * The JLC-simulated placement file for a placed board: positions are the centre of the soldered pads in our own copper
 * (read back from KiCad's Gerber plot), rotations are the ones JLC's own footprint needs, predicted by the BOM check
 * (`board_release bom`). Without a current BOM check the check is run from its evidence cache only (no lookups), and
 * parts it has no JLC footprint for keep KiCad's rotation (bottom parts seen from below), which the note says.
 */
import { readFileSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { release } from "@fabdesk/board-workflow";
import { bomDirOf, readBomState, readProxies, releaseHome } from "./release-state";

export interface JlcExport {
  cpl: string;
  bom: string;
  summary: { placements: number; pass: number; fail: number; noFootprint: string[]; rotationDiffers: number; noLcscCode: string[] };
  source: "current BOM check" | "evidence cache (no current BOM check)";
  failing: string[];
}

/**
 * JLC CPL/BOM beside a placement export. Reads the project's BOM check (`projectDir`); its own working files (an offline
 * BOM check when none is current, the copper Gerbers) go under `scratchDir` when given (the caller owns and removes it),
 * else under the project's release folder.
 */
export async function writeJlcExports(input: { exportGerbers: (outDir: string) => Promise<unknown>; projectDir: string; pcb: string; stem: string; posCsv: string; outDir: string; scratchDir?: string; signal?: AbortSignal }): Promise<JlcExport> {
  const state = await readBomState(input.projectDir, input.pcb);
  const work = input.scratchDir ?? releaseHome(input.projectDir);
  let bomDir = state.dir;
  let source: JlcExport["source"] = "current BOM check";
  if (state.state !== "current") {
    source = "evidence cache (no current BOM check)";
    bomDir = join(work, "pos-bom");
    await rm(bomDir, { recursive: true, force: true });
    await mkdir(bomDir, { recursive: true });
    await cp(join(bomDirOf(input.projectDir), "cache"), join(bomDir, "cache"), { recursive: true }).catch(() => {});
    await release.bomCheck({ project: input.projectDir, stem: input.stem, out: bomDir, offline: true, ...(input.signal ? { signal: input.signal } : {}) });
  }
  const gdir = join(work, "pos-gerbers");
  await rm(gdir, { recursive: true, force: true });
  await mkdir(gdir, { recursive: true });
  await input.exportGerbers(gdir);
  const copper = async (layer: string) => {
    const n = (await readdir(gdir)).find((x) => new RegExp(`-${layer}\\.\\w+$`).test(x));
    return n ? release.gerberPads(release.parseGerber(await readFile(join(gdir, n), "latin1"))) : new Map<string, Array<[number, number]>>();
  };
  const [top, bottom] = [await copper("F_Cu"), await copper("B_Cu")];
  const dec = JSON.parse(await readFile(join(bomDir, "bom-decisions.json"), "utf8")) as release.BomResult;
  const cpl = release.readCplJlc(await readFile(join(bomDir, "cpl-jlc.csv"), "utf8"));
  const pos = new Map(release.parseCsv(await readFile(input.posCsv, "utf8")).map((r) => [r["Ref"]!, r]));
  const rows = release.jlcRows(dec, cpl, pos, { top: release.padsByRef(top), bottom: release.padsByRef(bottom) });
  await mkdir(input.outDir, { recursive: true });
  const cplPath = join(input.outDir, "positions-jlc.csv");
  const bomPath = join(input.outDir, "bom-jlc.csv");
  await writeFile(cplPath, release.toCsv(release.JLC_CPL_FIELDS, rows.cpl));
  await writeFile(bomPath, release.toCsv(release.JLC_BOM_FIELDS, rows.bom));
  const codes: Record<string, string | undefined> = {};
  for (const r of rows.bom) for (const d of r[1]!.split(",")) codes[d] = r[3];
  const sim = release.simulatePlacement({
    cpl: rows.cpl.map((r) => ({ Designator: r[0]!, "Mid X": r[1]!, "Mid Y": r[2]!, Layer: r[3]!, Rotation: r[4]! })),
    codes,
    top,
    bottom,
    proxies: await readProxies(input.projectDir),
    eda: (code) => {
      try {
        return JSON.parse(readFileSync(join(bomDir, "cache", `eda-${code}.json`), "utf8"));
      } catch {
        return null;
      }
    },
  });
  await rm(gdir, { recursive: true, force: true });
  return {
    cpl: cplPath,
    bom: bomPath,
    source,
    failing: sim.parts.filter((p) => p.verdict === "FAIL").map((p) => p.ref),
    summary: { placements: rows.placements, pass: sim.summary.pass, fail: sim.summary.fail, noFootprint: sim.summary.no_jlc_footprint, rotationDiffers: rows.rotation_differs_from_kicad.length, noLcscCode: rows.no_lcsc_code },
  };
}
