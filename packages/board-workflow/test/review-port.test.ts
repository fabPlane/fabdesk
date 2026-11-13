/**
 * The review-stage pieces ported from the toolkit: silk inside the review, `review try`, the combined candidate and
 * change pictures of `review fix --apply`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classify,
  combinePlans,
  evaluate,
  fixProposals,
  loadCurrent,
  openReviewProject,
  planSig,
  reviewGate,
  runReview,
  silkFindings,
  tryPlan,
  type Candidate,
  type EditCandidateBuilder,
  type EditPlan,
  type FindingRecord,
} from "../src/index";
import { writeJsonFile } from "../src/files";
import { FIXTURE_BOARD } from "./fixtures";
import { PCB, fakeEnv } from "./review-fixture";

const dirs: string[] = [];
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "review-port-"));
  dirs.push(d);
  return d;
};
beforeAll(() => {
  process.env["FABDESK_FETCH_CACHE"] = join(tmpdir(), "review-test-empty-cache");
});
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function project(pcb = PCB) {
  const dir = await tmp();
  await writeFile(join(dir, "board.kicad_pcb"), pcb);
  await writeFile(join(dir, "board.kicad_sch"), "(kicad_sch)");
  return dir;
}

describe("silk inside the review", () => {
  test("stacked labels are a question that blocks the gate; a clean board has no silk finding", async () => {
    const clean = await openReviewProject(await project(FIXTURE_BOARD));
    const ok = await runReview(clean, fakeEnv(), { offline: true, checks: ["silk"] });
    const chk = ok.review.checks.find((c) => c.name === "silk")!;
    expect(chk.status).toBe("ok");
    expect(chk.layer).toBe("L6");
    expect(chk.detail).toMatch(/^3 labels on silk, 3 clean; 0 of 3 parts unlabelled; text \[1\.0, 0\.8\] mm/);
    expect(ok.review.findings.filter((f) => f.rule === "SILK")).toEqual([]);
    // R2 moved onto R1: the two labels touch and R1's sits under R2's body
    const stacked = await openReviewProject(await project(FIXTURE_BOARD.replace("(at 14 10 90)", "(at 11 9.6 0)")));
    const r = await runReview(stacked, fakeEnv(), { offline: true });
    const silk = r.review.findings.filter((f) => f.rule === "SILK");
    expect(silk.map((f) => [f.id, f.severity])).toEqual([["L6:SILK:-:-:labels", "question"]]);
    expect(silk[0]!.claim).toBe("2 of 3 reference labels unreadable or misleading on the silkscreen (over-label 2, under-part 2)");
    expect(silk[0]!.evidence[0]!.detail).toBe("R1 (F): over-label R2; under-part R2");
    expect(silk[0]!.proposal).toMatchObject({ by: "workflow", apply: { kind: "command" } });
    expect(r.evaluation.open.some((x) => x.id === "L6:SILK:-:-:labels")).toBe(true);
    expect(JSON.parse(await readFile(join(r.dir, "silk.json"), "utf8")).bad).toBe(2);
  });

  test("a silk plot that fails is a check error, not a clean silkscreen", async () => {
    const p = await openReviewProject(await project(FIXTURE_BOARD));
    const r = await runReview(p, fakeEnv({ gerberFails: true, calls: [] }), { offline: true, checks: ["silk"] });
    const chk = r.review.checks.find((c) => c.name === "silk")!;
    expect(chk.status).toBe("error");
    expect(chk.detail).toContain("exit 1: plot failed");
  });

  test("the review config's silk plan sets the rules", async () => {
    const dir = await project(FIXTURE_BOARD.replace("(at 14 10 90)", "(at 11 9.6 0)"));
    await writeJsonFile(join(dir, ".fabdesk", "board", "review", "config.json"), { silk: { skip: ["R1", "R2"], heights: [1.2] } });
    const r = await runReview(await openReviewProject(dir), fakeEnv(), { offline: true, checks: ["silk"] });
    expect(r.review.checks.find((c) => c.name === "silk")!.detail).toContain("text [1.2] mm");
  });

  test("outlines over copper are a question, unlabelled parts a note (counts from the verdict)", () => {
    const v = {
      labels: 4, wanted: 6, clean: 3, bad: 1, texts: 0, texts_bad: 0, text_counts: {}, text_rows: [],
      counts: { "over-copper": 1, unlabelled: 2, "outline-over-copper": 1 },
      rows: [
        { ref: "R1", side: "F", issues: [{ kind: "over-copper", with: ["R1:1", "R1:2", "C1:1", "C1:2"] }] },
        { ref: "U1", side: "F", issues: [{ kind: "outline-over-copper", with: ["C3"] }] },
        { ref: "TP1", side: "F", issues: [{ kind: "unlabelled", with: [] }] },
        { ref: "TP2", side: "B", issues: [{ kind: "unlabelled", with: [] }] },
      ],
    };
    const r = silkFindings(v, { heights: [1.0, 0.8], stroke: 0.16 });
    expect(r.findings.map((f) => [f.key, f.severity])).toEqual([["labels", "question"], ["outline", "question"], ["unlabelled", "note"]]);
    expect(r.findings[0]!.evidence[0]!.detail).toBe("R1 (F): over-copper R1:1, R1:2, C1:1");
    expect(r.findings[2]!.claim).toBe("2 of 6 parts have no label on the silkscreen (hidden, or no legal spot): TP1, TP2");
    expect(r.detail).toBe("4 labels on silk, 3 clean; 2 of 6 parts unlabelled; text [1.0, 0.8] mm / 0.16 mm stroke");
  });
});

/** A builder that writes a candidate board (C1 moved) without the edit stage, and records what it was asked. */
function fakeBuilder(dir: string, opts: { ready?: (id: string) => boolean } = {}) {
  const calls = { build: [] as string[], prove: [] as Array<{ plan: EditPlan; ids: string[] }> };
  let n = 0;
  const candidate = async (plan: EditPlan, ready: boolean, extra: Partial<Candidate> = {}): Promise<Candidate> => {
    const cdir = join(dir, ".fabdesk", "board", "edits", `${plan.id}-${n++}`);
    await mkdir(cdir, { recursive: true });
    await writeFile(join(cdir, "board.kicad_pcb"), PCB.replace("(at 30 20)", "(at 21 22)"));
    return { id: plan.id, dir: cdir, ready, notes: [ready ? "PASS proof" : "FAIL proof"], plan, verdict: ready ? "PASS proof" : "FAIL proof", stillOpen: [], newFindings: [], collateralNets: 0, unplannedMoved: 0, ...extra };
  };
  const b: EditCandidateBuilder = {
    async build(plan, f) {
      calls.build.push(f.id);
      // the rung that built it: make_room and a displacement (what the combined plan must carry)
      return candidate({ ...plan, move: (plan.move ?? []).map((m) => ({ ...m, make_room: true })), displace: { radius: 2, rotations: "keep" } }, opts.ready ? opts.ready(f.id) : true);
    },
    async prove(plan, findings) {
      calls.prove.push({ plan, ids: findings.map((f) => f.id) });
      return candidate(plan, true);
    },
  };
  return { b, calls };
}

/**
 * Edit proposals in the latest review: the decoupling finding's plan (a flow board's), and with `two` a second one that
 * adds a capacitor (the fixture has one decoupling finding; the toolkit merges any number). Returns their ids.
 */
async function withEdits(dir: string, two = true): Promise<string[]> {
  const p = await openReviewProject(dir);
  const cur = await loadCurrent(p);
  const rec = cur.review!;
  const decap = rec.findings.find((f) => f.rule === "DECAP")!;
  const base = { authority: "review proposal (workflow)", reason: decap.claim, board: dir, project: dir, spec: "" };
  decap.proposal = { by: "workflow", action: "move C1 next to U1.1", effect: "", apply: { kind: "edit", plan: { ...base, id: "fix-L3_DECAP_U1_-", move: [{ ref: "C1", near: "U1.1", make_room: true }] } } };
  const ids = [decap.id];
  if (two) {
    const plan: EditPlan = { ...base, id: "fix-L3_DECAP_U1_2", add: [{ ref: "C900", like: "C1", value: "100n", footprint: "F:x", pins: { "1": "VDD", "2": "GND" }, near: [21, 20], fields: {} }] };
    const f: FindingRecord = { ...decap, id: "L3:DECAP:U1:2", pad: "2", proposal: { ...decap.proposal, action: "add C900", apply: { kind: "edit", plan } } };
    rec.findings.push(f);
    ids.push(f.id);
  }
  await writeFile(join(cur.run!, "review.json"), JSON.stringify(rec, null, 1) + "\n");
  return ids;
}

describe("review fix: the combined candidate and the change pictures", () => {
  test("two READY edits are applied together and proven; each READY candidate and the combined one get a picture", async () => {
    const dir = await project();
    const p = await openReviewProject(dir);
    await runReview(p, fakeEnv(), { offline: true });
    const second = (await withEdits(dir))[1]!;
    const { b, calls } = fakeBuilder(dir);
    const r = await fixProposals(p, { apply: true, builder: b });
    expect(r.edits.map((e) => [e.id, e.candidate?.ready])).toEqual([["L3:DECAP:U1:-", true], [second, true]]);
    expect(calls.prove).toHaveLength(1);
    const plan = calls.prove[0]!.plan;
    expect(calls.prove[0]!.ids).toEqual(["L3:DECAP:U1:-", second]);
    expect(plan.id).toBe(`fix-combined-${p.name}`.replace(/[^\w.-]+/g, "_"));
    expect(plan.move).toEqual([{ ref: "C1", near: "U1.1", make_room: true }]);
    expect(plan.add!.map((a) => a.ref)).toEqual(["C900"]);
    expect(plan.displace).toEqual({ radius: 2, rotations: "keep" });
    expect(r.combined).toMatchObject({ fixes: ["L3:DECAP:U1:-", second], ready: true, still_open: [], plan: planSig(plan) });
    const rec = JSON.parse(await readFile(join(dir, ".fabdesk", "board", "review", "fixes", "combined.json"), "utf8"));
    expect(rec.ready).toBe(true);
    expect(rec.hash).toBe((await loadCurrent(p)).review!.hash);
    expect(r.pictures.map((x) => x.id)).toEqual(["L3:DECAP:U1:-", second, "combined (2 fixes)"]);
    expect(r.pictures[0]!.summary).toBe("tracks +0/-0, vias +0/-0, parts moved 1, added 0, removed 0");
    expect(await readFile(r.pictures[2]!.page, "utf8")).toContain("<svg");
    expect(r.lines.some((l) => l.startsWith("  COMBINED candidate (2 fixes): PASS proof; still open none; collateral nets 0; READY for adoption"))).toBe(true);
    // the gate puts both findings in the READY candidate
    const g = await reviewGate(p);
    expect(g.classified!.candidate).toEqual(expect.arrayContaining(["L3:DECAP:U1:-", second]));
    // the same design and plans: nothing is built or proven again
    const again = await fixProposals(p, { apply: true, builder: b });
    expect(calls.build).toHaveLength(2);
    expect(calls.prove).toHaveLength(1);
    expect(again.edits.every((e) => e.reused)).toBe(true);
    expect(again.combined?.dir).toBe(r.combined!.dir);
  });

  test("a candidate that is not READY is an agent task; one READY edit makes no combined candidate", async () => {
    const dir = await project();
    const p = await openReviewProject(dir);
    const run = await runReview(p, fakeEnv(), { offline: true });
    const second = (await withEdits(dir))[1]!;
    const { b, calls } = fakeBuilder(dir, { ready: (id) => id !== second });
    const r = await fixProposals(p, { apply: true, builder: b });
    expect(r.combined).toBeUndefined();
    expect(calls.prove).toHaveLength(0);
    expect(r.pictures.map((x) => x.id)).toEqual(["L3:DECAP:U1:-"]);
    const k = await classify(p, evaluate((await loadCurrent(p)).review!, {}).open, run.review.hash);
    expect(k.task.map((x) => x.id)).toContain(second);
    // a record of another design says nothing about this one
    const other = await classify(p, evaluate((await loadCurrent(p)).review!, {}).open, "0".repeat(64));
    expect(other.task.map((x) => x.id)).not.toContain(second);
  });

  test("build false (low disk) settles and builds nothing", async () => {
    const dir = await project();
    const p = await openReviewProject(dir);
    await runReview(p, fakeEnv(), { offline: true });
    await withEdits(dir, false);
    const { b, calls } = fakeBuilder(dir);
    const r = await fixProposals(p, { apply: true, builder: b, build: false });
    expect(calls.build).toEqual([]);
    expect(r.tasks.some((t) => t.steps[0]!.includes("disk low"))).toBe(true);
  });

  test("merging renames an added part whose reference is taken, keeps every move and the widest displacement", () => {
    const base = { authority: "a", reason: "r", board: "b", project: "b", spec: "" };
    const add = (ref: string) => ({ ref, like: "C1", value: "100n", footprint: "F:x", pins: {}, near: [], fields: {} });
    const plan = combinePlans("my board", [
      { id: "a", plan: { ...base, id: "pa", move: [{ ref: "C1", near: "U1.1", make_room: true }], add: [add("C900")], displace: { radius: 2, rotations: "keep" } } },
      { id: "b", plan: { ...base, id: "pb", add: [add("C900")], displace: { radius: 4, rotations: "keep" } } },
    ], ["C1", "C900"]);
    expect(plan.id).toBe("fix-combined-my_board");
    expect(plan.reason).toBe("combined READY review fixes: a, b");
    expect(plan.add!.map((a) => a.ref)).toEqual(["C901", "C902"]);
    expect(plan.move).toHaveLength(1);
    expect(plan.displace!.radius).toBe(4);
  });
});

describe("review try", () => {
  test("the agent's plan is proven against the findings it names; READY gets a picture and a record", async () => {
    const dir = await project();
    const p = await openReviewProject(dir);
    const run = await runReview(p, fakeEnv(), { offline: true });
    const mouth = run.review.findings.find((f) => f.rule === "MOUTH")!.id;
    const { b, calls } = fakeBuilder(dir);
    await expect(tryPlan(p, { plan: { id: "mine" } as EditPlan, ids: ["L9:NOPE:-:-"] }, b)).rejects.toThrow("not in the current review: L9:NOPE:-:-");
    await expect(tryPlan(p, { plan: { id: "bad id!" } as EditPlan }, b)).rejects.toThrow("plan.id is required");
    const r = await tryPlan(p, { plan: { id: "mine", move: [{ ref: "J1", to: [1, 15, 180] }] } as never, ids: [mouth] }, b);
    expect(calls.prove[0]!.ids).toEqual([mouth]);
    expect(calls.build).toEqual([]); // no ladder: the plan as written
    expect(r.ready).toBe(true);
    expect(r.picture?.summary).toContain("parts moved 1");
    expect(r.lines[0]).toBe(`mine: PASS proof; targeted ${mouth}; still open none; collateral nets 0; READY`);
    const saved = JSON.parse(await readFile(r.record, "utf8"));
    expect(saved).toMatchObject({ plan: "mine", fixes: [mouth], ready: true, hash: run.review.hash });
    expect(JSON.parse(await readFile(join(dir, ".fabdesk", "board", "review", "tries", "mine.plan.json"), "utf8")).id).toBe("mine");
  });

  test("a stale review must be run first", async () => {
    const dir = await project();
    const p = await openReviewProject(dir);
    await runReview(p, fakeEnv(), { offline: true });
    await writeFile(join(dir, "board.kicad_pcb"), PCB + "\n");
    await expect(tryPlan(p, { plan: { id: "x" } as EditPlan }, fakeBuilder(dir).b)).rejects.toThrow(/review is stale/);
  });
});
