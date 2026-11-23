/**
 * KiCad DRC JSON as the acceptance checks read it. `kicad-cli pcb drc --severity-all` also reports violations the board's
 * owner marked as excluded ("Intentional Overlap"), as ordinary errors; the toolkit runs without `--severity-all`
 * (errors and warnings, exclusions off). Reading the JSON with excluded items left out reproduces that.
 */
import { readFile } from "node:fs/promises";
import type { DrcInput } from "./accept";

interface RawItem {
  type?: string;
  severity?: string;
  description?: string;
  excluded?: boolean;
  items?: Array<{ description?: string }>;
}
interface RawDrc {
  violations?: RawItem[];
  unconnected_items?: RawItem[];
  schematic_parity?: RawItem[];
}

export function drcInputFromRaw(raw: RawDrc): DrcInput {
  const live = (l: RawItem[] | undefined) => (l ?? []).filter((v) => !v.excluded);
  return {
    violations: live(raw.violations).map((v) => ({ rule: v.type ?? "unknown", severity: v.severity ?? "error", description: v.description ?? "", items: (v.items ?? []).map((i) => ({ description: i.description ?? "" })) })),
    unconnected: live(raw.unconnected_items).length,
    parity: live(raw.schematic_parity).length,
  };
}

export async function drcInputFromFile(path: string): Promise<DrcInput> {
  return drcInputFromRaw(JSON.parse(await readFile(path, "utf8")) as RawDrc);
}
