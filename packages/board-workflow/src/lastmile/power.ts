/**
 * The last mile's power steps, no router: `escape` (fine-pitch power escapes, toolkit power_escape.py), `planes:FILE`
 * (split inner power plane from a plan, power_planes.py) and `pour` (net zones over open power connections,
 * pour_opens.py). Each writes a board folder the bench then scores and gates like any other step; the bench's scorer
 * applies the acceptance rules first, as pour_opens.py did before scoring.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkPlanesPlan, powerEscape, powerPlanes, pourOpens } from "../power/index";
import type { Requirements } from "../requirements";
import type { Step } from "./actions";
import { copyBoardFolder, type StepInput, type StepOutcome } from "./bench";
import type { DrcRun } from "./scoring";

export interface PowerStepHost {
  req: Requirements;
  /** A `planes:FILE` path resolved inside the project (refused outside it). */
  planFile(file: string): Promise<string>;
  /** Make sure the start board has its DRC record (`.lastmile/drc-run.json`): `pour` reads its open connections. */
  scored(): Promise<void>;
}

export async function powerStep(step: Step, input: StepInput, h: PowerStepHost): Promise<StepOutcome> {
  const { cur, out, pcb } = input;
  const text = await readFile(join(cur, pcb), "utf8");
  let next: string;
  let info: Record<string, unknown>;
  let record: unknown;
  if (step.type === "escape") {
    const o = step.escape ?? { maxStub: 0.9, clearance: 0.1 };
    const r = powerEscape(text, h.req.acceptance, o);
    next = r.text;
    info = { engine: "power_escape", ...r.stats };
    record = { ...r.stats, max_stub: o.maxStub, clearance: o.clearance, segments: r.segments };
  } else if (step.type === "planes") {
    if (!step.planFile) return { error: "planes needs a plan file: planes:FILE" };
    const file = await h.planFile(step.planFile);
    let plan;
    try {
      plan = checkPlanesPlan(JSON.parse(await readFile(file, "utf8")));
    } catch (e) {
      return { error: `planes:${step.planFile}: ${e instanceof Error ? e.message : String(e)}` };
    }
    const r = powerPlanes(text, plan);
    next = r.text;
    info = { engine: "power_planes", layer: r.record.layer, zones: r.record.zones, corridors: r.record.corridors, nets: r.record.nets };
    record = r.record;
  } else {
    await h.scored();
    const run = JSON.parse(await readFile(join(cur, ".lastmile", "drc-run.json"), "utf8")) as DrcRun;
    const o = step.pour ?? { nets: [], margin: 1.5, minWidthScale: 1.0 };
    const r = pourOpens(text, h.req.acceptance, run.unconnected, o);
    next = r.text;
    const made = r.made.filter((m) => "layer" in m);
    info = { engine: "pour_opens", pours: made.length, skipped: r.made.length - made.length, nets: [...new Set(made.map((m) => m.net))].slice(0, 12) };
    record = r.made;
  }
  // nothing added: the board is unchanged (the bench keeps the board it started from)
  if (next === text) return { dir: cur, skipped: true, info };
  await copyBoardFolder(cur, out);
  await writeFile(join(out, pcb), next);
  await mkdir(join(out, ".lastmile"), { recursive: true });
  await writeFile(join(out, ".lastmile", `${step.type}.json`), JSON.stringify(record, null, 1) + "\n");
  return { dir: out, info };
}
