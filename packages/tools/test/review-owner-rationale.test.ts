import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openReviewProject,
  runReview,
  reviewGate,
  fixProposals,
  intentInit,
  intentDecide,
  dispose,
} from "@fabdesk/board-workflow";
import { propose, coveringDecision } from "../../board-workflow/src/review/proposals";
import { fakeEnv, PCB } from "../../board-workflow/test/review-fixture";
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "r3-probe-"));
  dirs.push(dir);
  await writeFile(join(dir, "board.kicad_pcb"), PCB);
  await writeFile(join(dir, "board.kicad_sch"), "(kicad_sch)");
  const home = join(dir, ".fabdesk/board/review");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "config.json"), JSON.stringify({ checks_only: ["mouth"] }));
  await writeFile(join(dir, ".fabdesk/board/onboard.json"), "{}");
  return { p: await openReviewProject(dir), home };
}
const save = async (home: string, it: unknown) =>
  writeFile(join(home, "intent.json"), JSON.stringify(it));
for (const decision of ["", "   ", "\t", "\n", "\n\t", null, 4, undefined])
  test(`invalid decision ${JSON.stringify(decision)} never creates or applies owner acceptance`, async () => {
    const { p, home } = await fixture();
    const it = { decisions: [{ id: "bad", decision, covers: [{ rule: "MOUTH" }] }] };
    await save(home, it);
    const run = await runReview(p, fakeEnv(), { offline: true });
    const f = run.review.findings.find((f) => f.rule === "MOUTH")!;
    expect(run.evaluation.rows.find((r) => r.id === f.id)!.open).toBe(true);
    expect(coveringDecision(f, it as any)).toBeNull();
    expect(
      propose(f, { dir: p.dir, hasRequirements: false }, it as any, {
        comps: null,
        oracle_pins: {},
      })?.apply.kind,
    ).not.toBe("disposition");
    f.proposal = {
      by: "workflow",
      action: "legacy",
      effect: "",
      apply: {
        kind: "disposition",
        as: "owner",
        state: "accept",
        reason: "owner decision bad ():   ",
      },
    };
    await writeFile(join(run.dir, "review.json"), JSON.stringify(run.review));
    expect((await fixProposals(p, { apply: true, build: false })).settled).toEqual([]);
    expect(
      JSON.parse(await readFile(join(home, "dispositions.json"), "utf8"))[f.id],
    ).toBeUndefined();
    const before = await readFile(join(home, "intent.json"), "utf8");
    await expect(
      intentDecide(p, { id: "rejected", decision: decision as any, covers: [f.id] }),
    ).rejects.toThrow("decision text");
    expect(await readFile(join(home, "intent.json"), "utf8")).toBe(before);
  });
for (const legacy of [true, false])
  test(`valid ${legacy ? "legacy" : "tool"} intent and shipped proposal preserve full rationale`, async () => {
    const { p, home } = await fixture();
    const reason =
      "Connector faces inward intentionally. " +
      " ".repeat(220) +
      "Bench checked with the actual mating connector.";
    if (legacy)
      await save(home, {
        decisions: [{ id: "D1", decision: reason, covers: [{ rule: "MOUTH" }] }],
      });
    else {
      await intentInit(p);
      await intentDecide(p, { id: "D1", decision: reason, covers: ["L4:MOUTH:J1:*"] });
    }
    let run = await runReview(p, fakeEnv(), { offline: true });
    const f = run.review.findings.find((f) => f.rule === "MOUTH")!;
    expect(run.evaluation.rows.find((r) => r.id === f.id)!.disposition?.reason).toBe(
      `intent decision D1: ${reason}`,
    );
    expect(f.proposal?.apply.kind).toBe("disposition");
    if (f.proposal?.apply.kind === "disposition") expect(f.proposal.apply.reason).toEndWith(reason);
    // An explicit 'fix' keeps the finding open, exercising actual application of the shipped proposal.
    await dispose(p, { id: f.id, state: "fix", by: "agent", reason: "Still requires resolution" });
    expect((await fixProposals(p, { apply: true, build: false })).settled).toContain(f.id);
    const disp = JSON.parse(await readFile(join(home, "dispositions.json"), "utf8"))[f.id];
    expect(disp.by).toBe("owner");
    expect(disp.reason).toBe(`intent decision D1: ${reason}`);
    run = await runReview(p, fakeEnv(), { offline: true });
    expect(run.evaluation.rows.find((r) => r.id === f.id)!.open).toBe(false);
  });
for (const mutation of ["removed", "blank", "changed"])
  test(`saved shipped proposal revalidates intent ${mutation}`, async () => {
    const { p, home } = await fixture();
    await intentInit(p);
    await intentDecide(p, {
      id: "D1",
      decision: "Connector faces inward on purpose",
      covers: ["L4:MOUTH:J1:*"],
    });
    const run = await runReview(p, fakeEnv(), { offline: true });
    const f = run.review.findings.find((f) => f.rule === "MOUTH")!;
    await dispose(p, { id: f.id, state: "fix", by: "agent", reason: "Still requires resolution" });
    if (mutation === "removed") await rm(join(home, "intent.json"));
    else
      await save(home, {
        decisions: [
          {
            id: "D1",
            decision: mutation === "blank" ? "   " : "New owner rationale",
            covers: [{ id: f.id }],
          },
        ],
      });
    const fixed = await fixProposals(p, { apply: true, build: false });
    const disp = JSON.parse(await readFile(join(home, "dispositions.json"), "utf8"))[f.id];
    if (mutation === "changed") {
      expect(fixed.settled).toContain(f.id);
      expect(disp.reason).toBe("intent decision D1: New owner rationale");
    } else {
      expect(fixed.settled).toEqual([]);
      expect(disp.state).toBe("fix");
      expect(fixed.tasks.some((t) => t.id === f.id)).toBe(true);
    }
  });
test("invalid first decision does not shadow valid later coverage", async () => {
  const { p, home } = await fixture();
  await save(home, {
    decisions: [
      { id: "bad", decision: " ", covers: [{ rule: "MOUTH" }] },
      { id: "good", decision: "Inward connector intended", covers: [{ rule: "MOUTH" }] },
    ],
  });
  const run = await runReview(p, fakeEnv(), { offline: true });
  const row = run.evaluation.rows.find((r) => r.rule === "MOUTH")!;
  expect(row.open).toBe(false);
  expect(row.disposition?.reason).toBe("intent decision good: Inward connector intended");
});

for (const as of ["owner", "nobody", undefined])
  test(`non-agent saved proposal requires current authority: ${as}`, async () => {
    const { p, home } = await fixture();
    const run = await runReview(p, fakeEnv(), { offline: true });
    const f = run.review.findings.find((f) => f.rule === "MOUTH")!;
    f.proposal = {
      by: "workflow",
      action: "unsafe saved proposal",
      effect: "",
      apply: { kind: "disposition", as, state: "accept", reason: null },
    } as any;
    await writeFile(join(run.dir, "review.json"), JSON.stringify(run.review));
    const fixed = await fixProposals(p, { apply: true, build: false });
    expect(fixed.settled).toEqual([]);
    expect(fixed.lines.join("\n")).toContain("no valid current covering owner decision");
    expect(fixed.tasks.some((t) => t.id === f.id)).toBe(true);
    expect(
      JSON.parse(await readFile(join(home, "dispositions.json"), "utf8"))[f.id],
    ).toBeUndefined();
  });

test("saved decision ID does not shadow a new valid current covering decision", async () => {
  const { p, home } = await fixture();
  await save(home, {
    decisions: [{ id: "old", decision: "Original approval", covers: [{ rule: "MOUTH" }] }],
  });
  const run = await runReview(p, fakeEnv(), { offline: true });
  const f = run.review.findings.find((f) => f.rule === "MOUTH")!;
  expect(f.proposal?.apply).toHaveProperty("intent_decision", "old");
  await dispose(p, { id: f.id, state: "fix", by: "agent", reason: "Recheck" });
  await save(home, {
    decisions: [
      { id: "old", decision: " ", covers: [{ rule: "MOUTH" }] },
      {
        id: "new\nID",
        by: "owner",
        decision: "Replacement approval with current evidence",
        covers: [{ id: f.id }],
      },
    ],
  });
  expect((await fixProposals(p, { apply: true, build: false })).settled).toContain(f.id);
  const disp = JSON.parse(await readFile(join(home, "dispositions.json"), "utf8"))[f.id];
  expect(disp.by).toBe("owner");
  expect(disp.reason).toBe("intent decision new\nID: Replacement approval with current evidence");
});
