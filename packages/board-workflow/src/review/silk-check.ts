/**
 * L6 silk: reference labels and part outlines on the silkscreen, judged inside the review (the toolkit's
 * `check_silk`), so a board with unreadable labels cannot pass the review gate without a disposition.
 *
 * KiCad DRC files silk as warnings and tests strokes only: stacked labels whose boxes touch pass it but read as one, and
 * a label under another part's body is invisible once assembled (C6-eco95 carried 388 silk warnings through a passing
 * review). The judge is the silk stage's (`silk/engine.ts` `judge` on `buildSilkModel`: mask and silk shapes from
 * KiCad's own Gerber plot, labels from the board file). Rules: `review.silk` in the review config (a silk plan, as
 * `board_silk`'s `plan`); the fix is the silk stage's place (silk only, copper unchanged).
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildSilkModel } from "../silk/model";
import { judge, type Plan, type Verdict } from "../silk/engine";
import { projectSilkPlan } from "../silk/project-plan";
import type { ReviewCtx } from "./context";
import { makeFinding, newResult, type CheckResult } from "./types";

const EXAMPLES = 4;

/** Label issues that make a reference unreadable or misleading (the toolkit's SILK_LABEL). */
export const SILK_LABEL = new Set(["over-copper", "over-silk", "over-label", "under-part", "edge", "small", "orientation", "wrong-side", "far", "ambiguous", "duplicate"]);
const OUTLINE = new Set(["outline-over-copper", "outline-overlap"]);

type Row = Verdict["rows"][number];
const line = (row: Row, kinds: Set<string>) =>
  `${row.ref} (${row.side}): ` +
  row.issues
    .filter((i) => kinds.has(i.kind))
    .map((i) => i.kind + (i.with.length ? ` ${i.with.slice(0, 3).join(", ")}` : ""))
    .join("; ");

/** The findings of one silk verdict (pure: the review check and its tests share it). */
export function silkFindings(v: Verdict, plan: { heights: number[]; stroke: number }): Pick<CheckResult, "findings" | "detail"> {
  const findings: CheckResult["findings"] = [];
  const bad = v.rows.filter((row) => row.issues.some((i) => SILK_LABEL.has(i.kind)));
  if (bad.length) {
    const cnt = Object.entries(v.counts)
      .filter(([k]) => SILK_LABEL.has(k))
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n}`)
      .join(", ");
    findings.push(
      makeFinding({
        layer: "L6",
        rule: "SILK",
        severity: "question",
        claim: `${bad.length} of ${v.labels} reference labels unreadable or misleading on the silkscreen (${cnt})`,
        key: "labels",
        evidence: bad.slice(0, EXAMPLES).map((row) => ({ source: "silk judge (exact KiCad shapes)", detail: line(row, SILK_LABEL) })),
        suggest: 'board_silk {"action": "place"}',
      }),
    );
  }
  const outl = v.rows.filter((row) => row.issues.some((i) => OUTLINE.has(i.kind)));
  if (outl.length)
    findings.push(
      makeFinding({
        layer: "L6",
        rule: "SILK",
        severity: "question",
        claim: `${outl.length} part outline(s) on the silkscreen cross copper or another part's outline`,
        key: "outline",
        evidence: outl.slice(0, EXAMPLES).map((row) => ({ source: "silk judge", detail: line(row, OUTLINE) })),
        suggest: "fab clips silk off pads; move the part, or accept the clipped outline",
      }),
    );
  const unl = v.rows.filter((row) => row.issues.some((i) => i.kind === "unlabelled")).map((row) => row.ref);
  if (unl.length)
    findings.push(
      makeFinding({
        layer: "L6",
        rule: "SILK",
        severity: "note",
        claim: `${unl.length} of ${v.wanted} parts have no label on the silkscreen (hidden, or no legal spot): ${unl.slice(0, 12).join(", ")}${unl.length > 12 ? " ..." : ""}`,
        key: "unlabelled",
      }),
    );
  const detail = `${v.labels} labels on silk, ${v.clean} clean; ${unl.length} of ${v.wanted} parts unlabelled; text [${plan.heights.map((h) => (Number.isInteger(h) ? h.toFixed(1) : String(h))).join(", ")}] mm / ${plan.stroke} mm stroke`;
  return { findings, detail };
}

export async function checkSilk(ctx: ReviewCtx): Promise<CheckResult> {
  const r = newResult("silk", "L6");
  const { plan, provenance } = await projectSilkPlan(ctx.project.files.pro, (ctx.project.cfg.silk ?? null) as Partial<Plan> | null);
  r.artifacts["silkRules"] = provenance;
  const run = async (args: string[]) => {
    const res = await ctx.env.kicad(args);
    // a plot that failed would leave no mask or silk shapes: every label would look clean
    if (res.exitCode !== 0) throw new Error(`kicad-cli ${args.slice(0, 3).join(" ")} exit ${res.exitCode}: ${(res.stderr || res.stdout).trim().slice(0, 160)}`);
  };
  let v: Verdict;
  try {
    const m = await buildSilkModel(ctx.pcbText, { run, workDir: join(ctx.out, "silk"), ...(ctx.env.signal ? { signal: ctx.env.signal } : {}) });
    v = judge(m, plan);
    const overlap = v.rows.map(row => ({ ref: row.ref, labelBox: m.parts[row.ref]?.label.box, issues: row.issues, plottedCopper: m.copper[row.side as "F" | "B"], plottedSilk: m.silk[row.side as "F" | "B"] }));
    const path = join(ctx.out, "silk-geometry.json");
    await writeFile(path, JSON.stringify({ basis: "plotted polygons and label bounding boxes", rules: provenance, overlaps: overlap }) + "\n");
    r.artifacts["silkGeometry"] = path;
  } catch (e) {
    r.status = "error";
    r.detail = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    return r;
  }
  const out = join(ctx.out, "silk.json");
  await writeFile(out, JSON.stringify(v, null, 1) + "\n");
  r.artifacts["silk"] = out;
  const { findings, detail } = silkFindings(v, plan);
  r.findings.push(...findings);
  r.detail = detail;
  return r;
}
