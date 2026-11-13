/**
 * The review-stage pieces ported from the toolkit: silk inside the review.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openReviewProject, runReview, silkFindings } from "../src/index";
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
