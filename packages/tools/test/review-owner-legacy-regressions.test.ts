import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openReviewProject, runReview, reviewGate, fixProposals } from "@fabdesk/board-workflow";
import { fakeEnv, PCB } from "../../board-workflow/test/review-fixture";
import { recordReviewGate, readReviewGate, gateLabels } from "../src/board-state";
import { fabricationGate } from "../src/fabrication-gate";
import { intentDecide } from "@fabdesk/board-workflow";
import { releaseFab } from "../../board-workflow/src/release/fab";
const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});
const json = async (dir: string, path: string, value: unknown) => {
  await mkdir(join(dir, path, ".."), { recursive: true });
  await writeFile(join(dir, path), JSON.stringify(value));
};
const id = "L8:EXPERT:-:-:pending";
async function project(checks = ["identity"]) {
  const dir = await mkdtemp(join(tmpdir(), "settlement-validation-"));
  dirs.push(dir);
  await writeFile(join(dir, "board.kicad_pcb"), PCB);
  await writeFile(join(dir, "board.kicad_sch"), "(kicad_sch)");
  await json(dir, ".fabdesk/board/review/config.json", { checks_only: checks });
  await json(dir, ".fabdesk/board/onboard.json", {});
  return openReviewProject(dir);
}
async function gates(p: Awaited<ReturnType<typeof project>>, expected: "open" | "pass") {
  const live = await reviewGate(p);
  await recordReviewGate(p.dir, { ...live, ...gateLabels(live) });
  const saved = await readReviewGate(p.dir);
  let fab = "pass";
  try {
    await fabricationGate(p.dir, "export_gerbers");
  } catch (e) {
    expect(String(e)).toContain("fabrication refused");
    fab = "open";
  }
  expect({ live: live.state, saved: saved.state, fab }).toEqual({
    live: expected,
    saved: expected,
    fab: expected,
  });
  return live;
}

test("legacy multiline decision ID cannot bypass validation", async () => {
  const p = await project(["pack"]);
  await json(p.dir, ".fabdesk/board/review/intent.json", {
    decisions: [{ id: "D\n1", by: "owner", decision: "   ", covers: [{ id }] }],
  });
  const run = await runReview(p, fakeEnv(), { offline: true });
  const f = run.review.findings.find((f) => f.id === id)!;
  f.proposal = {
    by: "workflow",
    action: "settle by owner decision",
    effect: "",
    apply: {
      kind: "disposition",
      as: "owner",
      state: "accept",
      reason: "owner decision D\n1 ():    ",
    },
  };
  await writeFile(join(run.dir, "review.json"), JSON.stringify(run.review));
  await gates(p, "open");
  const fix = await fixProposals(p, { apply: true, build: false });
  expect(fix.settled).toEqual([]);
  expect(
    JSON.parse(await readFile(join(p.dir, ".fabdesk/board/review/dispositions.json"), "utf8")),
  ).toEqual({});
  expect(fix.lines.join("\n")).toContain("no valid current covering owner decision");
  let releaseStop = "";
  try {
    await releaseFab({
      project: p.dir,
      stem: "board",
      pcb: p.pcb,
      schematic: null,
      out: join(p.dir, "pkg"),
      cli: {} as any,
      gates: {
        review: async () => {
          const g = await reviewGate(p);
          return { state: g.state, open: g.open, mustFix: g.mustFix };
        },
        acceptance: async () => {
          throw new Error("ACCEPTANCE REACHED");
        },
      },
    });
  } catch (e) {
    releaseStop = String(e);
  }
  expect(releaseStop).toContain("STOP review gate");
  await gates(p, "open");
});
test("revalidated proposal retains complete current rationale", async () => {
  const p = await project(["pack"]);
  const decision = " ".repeat(210) + "Prototype approved after independent verification";
  await json(p.dir, ".fabdesk/board/review/intent.json", {
    decisions: [{ id: "D1", by: "owner", decision, covers: [{ id }] }],
  });
  await json(p.dir, ".fabdesk/board/review/dispositions.json", {
    [id]: { state: "fix", by: "agent", reason: "Recheck" },
  });
  await runReview(p, fakeEnv(), { offline: true });
  const fix = await fixProposals(p, { apply: true, build: false });
  const d = JSON.parse(
    await readFile(join(p.dir, ".fabdesk/board/review/dispositions.json"), "utf8"),
  )[id];
  expect(fix.settled).toContain(id);
  await gates(p, "pass");
  expect(d.reason).toContain(decision);
});

test("releaseFab refuses standard R1/R2 records at review", async () => {
  for (const record of [
    { state: "accept", reason: "waiver" },
    { state: "accept", by: "nobody", reason: "waiver" },
    { state: "bogus", by: "agent", reason: "waiver" },
    null,
  ]) {
    const p = await project(["pack"]);
    if (record) await json(p.dir, ".fabdesk/board/review/dispositions.json", { [id]: record });
    else
      await json(p.dir, ".fabdesk/board/review/intent.json", {
        decisions: [{ id: "D1", by: "owner", decision: "   ", covers: [{ id }] }],
      });
    await runReview(p, fakeEnv(), { offline: true });
    await fixProposals(p, { apply: true, build: false });
    let acceptance = false;
    await expect(
      releaseFab({
        project: p.dir,
        stem: "board",
        pcb: p.pcb,
        schematic: null,
        out: join(p.dir, "pkg"),
        cli: {} as any,
        gates: {
          review: async () => {
            const g = await reviewGate(p);
            return { state: g.state, open: g.open, mustFix: g.mustFix };
          },
          acceptance: async () => {
            acceptance = true;
            throw new Error("ACCEPTANCE REACHED");
          },
        },
      }),
    ).rejects.toThrow("STOP review gate");
    expect(acceptance).toBe(false);
    expect(
      await readFile(join(p.dir, "pkg/manifest.json")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  }
});
test("intent writer and legacy valid proposal controls", async () => {
  const p = await project(["pack"]);
  await json(p.dir, ".fabdesk/board/review/intent.json", { decisions: [] });
  await runReview(p, fakeEnv(), { offline: true });
  await expect(intentDecide(p, { id: "blank", decision: "   ", covers: [id] })).rejects.toThrow(
    "decision text",
  );
  const d = await intentDecide(p, { id: "D1", decision: "Prototype approved", covers: [id] });
  expect(d.decision.by).toBe("owner");
  expect(d.settles).toContain(id);
  await gates(p, "pass");
  await json(p.dir, ".fabdesk/board/review/dispositions.json", {
    [id]: { state: "fix", by: "agent", reason: "recheck" },
  });
  const run = await runReview(p, fakeEnv(), { offline: true });
  const f = run.review.findings.find((f) => f.id === id)!;
  if (f.proposal?.apply.kind === "disposition") delete f.proposal.apply.intent_decision;
  await writeFile(join(run.dir, "review.json"), JSON.stringify(run.review));
  expect((await fixProposals(p, { apply: true, build: false })).settled).toContain(id);
  await gates(p, "pass");
});
