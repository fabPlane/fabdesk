/**
 * CAM export for a fabrication package: Gerbers and Excellon drill through kicad-cli with the layers a fab house needs
 * named explicitly (the board's saved plot settings can leave layers out, or name another plot format), exported twice
 * into separate folders; the files must be identical after the date lines are removed.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runKicadCli, type KicadCli } from "@fabdesk/kicad";

export const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

/** Date/time lines KiCad writes into Gerber X2 and Excellon headers, which differ between two exports of one board. */
const NORM: RegExp[] = [
  /^(G04 #@! |; #@! |%)TF\.CreationDate,[^\n]*\n/gm, // Gerber X2 / Excellon creation date
  /^G04 Created by KiCad[^\n]*\n/gm,
  /^; DRILL file [^\n]*\n/gm,
  /"CreationDate":\s*"[^"]*"/g,
];

export function normalisedHash(bytes: Uint8Array): string {
  let t = Buffer.from(bytes).toString("latin1");
  for (const rx of NORM) t = t.replace(rx, "");
  return sha256(Buffer.from(t, "latin1"));
}

/** What a fab house needs: every copper layer, mask and silkscreen both sides, the outline; paste where SMD pads are. */
export function requiredLayers(pcbText: string): string[] {
  const copper = [...pcbText.matchAll(/\(\d+ "((?:F|B|In\d+)\.Cu)" (?:signal|power|mixed|jumper)/g)].map((m) => m[1]!);
  const need = [...(copper.length ? copper : ["F.Cu", "B.Cu"]), "F.Mask", "B.Mask", "F.Silkscreen", "B.Silkscreen", "Edge.Cuts"];
  if (pcbText.includes("(pad ") && pcbText.includes(" smd ")) need.push("F.Paste", "B.Paste");
  return need;
}

export async function exportCam(cli: KicadCli, pcb: string, dir: string, layers: string[], signal?: AbortSignal): Promise<void> {
  await mkdir(dir, { recursive: true });
  const o = { ...(signal ? { signal } : {}) };
  // refill first: saved fills go stale after edits
  await runKicadCli(cli, ["pcb", "export", "gerbers", "--check-zones", "--output", dir + "/", "--layers", layers.join(","), pcb], o);
  await runKicadCli(cli, ["pcb", "export", "drill", "--output", dir + "/", "--format", "excellon", "--excellon-separate-th", "--generate-map", "--map-format", "gerberx2", pcb], o);
}

export interface Reproducibility {
  files: number;
  raw_identical: number;
  normalised_identical: number;
  differ: string[];
  pass: boolean;
}

async function hashDir(dir: string): Promise<{ norm: Record<string, string>; raw: Record<string, string> }> {
  const norm: Record<string, string> = {};
  const raw: Record<string, string> = {};
  for (const n of (await readdir(dir)).sort()) {
    const b = await readFile(join(dir, n));
    norm[n] = normalisedHash(b);
    raw[n] = sha256(b);
  }
  return { norm, raw };
}

/** Export twice and compare: the same board must make the same CAM files, date lines aside. */
export async function reproducible(cli: KicadCli, pcb: string, outDir: string, layers: string[], signal?: AbortSignal): Promise<Reproducibility> {
  const a = join(outDir, "repro-a");
  const b = join(outDir, "repro-b");
  await exportCam(cli, pcb, a, layers, signal);
  await exportCam(cli, pcb, b, layers, signal);
  const [ha, hb] = await Promise.all([hashDir(a), hashDir(b)]);
  const names = new Set([...Object.keys(ha.norm), ...Object.keys(hb.norm)]);
  const differ = [...names].filter((k) => ha.norm[k] !== hb.norm[k]).sort();
  const rawSame = Object.keys(ha.raw).filter((k) => hb.raw[k] === ha.raw[k]).length;
  return { files: Object.keys(ha.norm).length, raw_identical: rawSame, normalised_identical: Object.keys(ha.norm).length - differ.length, differ, pass: differ.length === 0 && Object.keys(ha.norm).length === Object.keys(hb.norm).length };
}
