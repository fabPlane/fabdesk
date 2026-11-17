/**
 * The acceptance's rules on a project folder before it is judged (the toolkit ran `apply_netclasses.py` on the
 * `.kicad_pro` before every `check_acceptance.py`: edit scoring, `bench.py` scoring and validate, `fab.py` before A1-A9,
 * `score_route.py`). KiCad DRC reads the project's classes and `.kicad_dru`, so without this a board onboarded bare
 * (`native_project_rules` false) is judged against whatever rules its project file happens to hold. A board whose
 * acceptance keeps its native rules is left alone, and a project already holding the rules is not rewritten.
 */
import { stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { writeNetclasses } from "./layout/score";
import { readRequirements } from "./onboard";
import type { Requirements } from "./requirements";

/**
 * Apply the rules to the project file beside `pcb` (relative to `dir`, or absolute). The requirements are the folder's
 * own (`.fabdesk/board/requirements`) unless given. Returns what was done and whether a file changed, or null when there is
 * no project file or no requirements to apply.
 */
export async function applyProjectRules(dir: string, pcb: string, req?: Requirements | null, dryRun = false): Promise<{ changed: boolean; text: string } | null> {
  const board = resolve(dir, pcb);
  const pro = join(dirname(board), `${basename(board).replace(/\.kicad_pcb$/, "")}.kicad_pro`);
  if (!(await stat(pro).then((s) => s.isFile(), () => false))) return null;
  const r = req ?? (await readRequirements(dir));
  if (!r) return null;
  return writeNetclasses(pro, r.acceptance, dryRun);
}
