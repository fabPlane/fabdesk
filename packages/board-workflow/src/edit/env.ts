/** What an edit needs to know about a project: its board, its requirements, which parts are fixed. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { exists, locateProject } from "../files";
import { readOnboardRecord, readRequirements } from "../onboard";
import type { Requirements } from "../requirements";

export interface EditEnv {
  projectDir: string;
  /** Board file name in the project folder. */
  pcbName: string;
  stem: string;
  pcbText: string;
  req: Requirements;
  /** Fixed references: the onboarded fixed parts and every mechanical anchor. */
  fixed: ReadonlySet<string>;
  /** Interconnect contract entries (`hardware/interconnect-contracts.json` or `.fabdesk/board/interconnect-contracts.json`), when the project has them. */
  contracts: Array<Record<string, unknown>>;
}

export async function loadEditEnv(projectDir: string, pcb?: string): Promise<EditEnv> {
  const files = await locateProject(projectDir, pcb);
  const req = await readRequirements(projectDir);
  if (!req) throw new Error("no requirements: onboard the board first (board_check does it; .fabdesk/board/requirements is missing)");
  const record = await readOnboardRecord(projectDir);
  const fixed = new Set<string>([...(record?.fixed ?? []), ...req.mechanical.anchors.map((a) => a.reference)]);
  let contracts: Array<Record<string, unknown>> = [];
  for (const p of [join(projectDir, "hardware", "interconnect-contracts.json"), join(projectDir, ".fabdesk", "board", "interconnect-contracts.json")]) {
    if (await exists(p)) {
      contracts = (JSON.parse(await readFile(p, "utf8")) as { interfaces?: Array<Record<string, unknown>> }).interfaces ?? [];
      break;
    }
  }
  return {
    projectDir,
    pcbName: files.pcb.slice(files.pcb.lastIndexOf("/") + 1),
    stem: files.stem,
    pcbText: await readFile(files.pcb, "utf8"),
    req,
    fixed,
    contracts,
  };
}

export const pairsOf = (req: Requirements): Array<[string, string]> => Object.values(req.acceptance.net_classes.classes).flatMap((c) => c.pairs ?? []);
