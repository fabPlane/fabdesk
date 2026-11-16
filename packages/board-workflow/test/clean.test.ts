/** The toolkit's tools/clean.py for Fabdesk's own folders: a dry-run plan with reasons, then delete. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyClean, cleanLines, cleanPlan } from "../src/clean";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
const put = async (path: string, text = "x") => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};

async function project() {
  const dir = await mkdtemp(join(tmpdir(), "clean-"));
  dirs.push(dir);
  const b = (...p: string[]) => join(dir, ".fabdesk", "board", ...p);
  await put(join(dir, "board.kicad_pcb"), "(kicad_pcb now)");
  await put(join(dir, "board.kicad_sch"), "sheet");
  await put(b("requirements", "acceptance.json"), "{}");
  // five review runs, the latest an old one by name
  for (const r of ["20261101T000000Z-a", "20261102T000000Z-b", "20261103T000000Z-c", "20261104T000000Z-d", "20261105T000000Z-e"]) await put(b("review", "runs", r, "review.json"), "{}");
  await put(b("review", "latest.json"), JSON.stringify({ run: "20261101T000000Z-a" }));
  // edit candidates: one of the board as it is, one of an earlier board, one whose sheet moved on
  await put(b("edits", "keep-1", "before", "board.kicad_pcb"), "(kicad_pcb now)");
  await put(b("edits", "keep-1", "board.kicad_pcb"), "(kicad_pcb edited)");
  await put(b("edits", "old-1", "before", "board.kicad_pcb"), "(kicad_pcb was)");
  await put(b("edits", "old-1", "board.kicad_pcb"), "(kicad_pcb edited)".repeat(100));
  await put(b("edits", "sheet-1", "before", "board.kicad_pcb"), "(kicad_pcb now)");
  await put(b("edits", "sheet-1", "origin.json"), JSON.stringify({ files: { "board.kicad_sch": "0".repeat(64) } }));
  await put(b("edits", ".before", "aaa", "before.json"), "{}");
  await put(b("edits", ".before", "bbb", "before.json"), "{}");
  await utimes(b("edits", ".before", "aaa"), new Date(1000), new Date(1000));
  // four adopt backups
  for (const s of ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"]) await put(b("adopt", s, "before", "board.kicad_pcb"));
  // a finished layout workspace (route PASS on route/rank-f) and one in progress
  const ws = b("layout", "ws");
  await put(join(ws, "flow.json"), JSON.stringify({ stages: { route: { status: "pass", verdict: `PASS route best open 2 A8 0 A7 0 (${join(ws, "route", "rank-f")})`, result: { tm: { dir: join(ws, "route", "tm") } } } } }));
  for (const p of ["place/seeds-0-7/s0/board.kicad_pcb", "rank/s0/board.kicad_pcb", "rank/s3/board.kicad_pcb", "route/rank-f/board.kicad_pcb", "route/tm/board.kicad_pcb", "base/board.kicad_pcb"]) await put(join(ws, p));
  await put(b("layout", "busy", "flow.json"), JSON.stringify({ stages: { place: { status: "pass" } } }));
  await put(b("layout", "busy", "place", "seeds-0-7", "s0", "board.kicad_pcb"));
  // a last-mile workspace: t1/c0 accepted, t1/c1 not
  const lm = b("lastmile", "main");
  await put(join(lm, "state.json"), JSON.stringify({ history: [{ dir: join(lm, "base") }, { dir: join(lm, "t1", "c0") }] }));
  for (const p of ["base/board.kicad_pcb", "t1/c0/board.kicad_pcb", "t1/c1/board.kicad_pcb", "cache/x"]) await put(join(lm, p));
  await put(b("release", "vias", "board.kicad_pcb"));
  await put(b("release", "bom", "bom-decisions.json"));
  return { dir, b };
}

describe("clean", () => {
  test("lists each reproducible copy with its reason; keeps what is still in use", async () => {
    const { dir } = await project();
    const plan = await cleanPlan(dir, { keep: 3 });
    const paths = plan.remove.map((i) => i.path.replace(".fabdesk/board/", "")).sort();
    expect(paths).toEqual(
      [
        "adopt/2026-11-01",
        "edits/.before/aaa",
        "edits/old-1",
        "edits/sheet-1",
        "lastmile/main/cache",
        "lastmile/main/t1/c1",
        "layout/ws/place/seeds-0-7",
        "layout/ws/rank/s0",
        "layout/ws/rank/s3",
        "layout/ws/route/tm",
        "release/vias/board.kicad_pcb",
        "review/runs/20261102T000000Z-b",
      ].sort(),
    );
    const why = Object.fromEntries(plan.remove.map((i) => [i.path.replace(".fabdesk/board/", ""), i.why]));
    expect(why["edits/old-1"]).toContain("can no longer be adopted");
    expect(why["edits/sheet-1"]).toContain("board.kicad_sch changed");
    expect(plan.remove[0]!.path).toBe(".fabdesk/board/edits/old-1"); // the largest first
    const kept = plan.kept.map((k) => k.path.replace(".fabdesk/board/", ""));
    expect(kept).toEqual(expect.arrayContaining(["review/runs/20261101T000000Z-a", "edits/keep-1", "layout/ws/route/rank-f", "layout/busy", "lastmile/main"]));
    expect(cleanLines(plan)[0]).toMatch(/^12 folder\(s\)\/file\(s\), \d+ kB reproducible:$/);
  });
  test("apply deletes exactly the plan, inside .fabdesk/board only", async () => {
    const { dir, b } = await project();
    const plan = await cleanPlan(dir, { keep: 3 });
    plan.remove.push({ path: "board.kicad_pcb", bytes: 1, why: "outside: must survive" });
    const r = await applyClean(dir, plan);
    expect(r.removed).toBe(12);
    expect(await readdir(dir)).toContain("board.kicad_pcb");
    expect((await readdir(b("review", "runs"))).sort()).toEqual(["20261101T000000Z-a", "20261103T000000Z-c", "20261104T000000Z-d", "20261105T000000Z-e"]);
    expect((await readdir(b("edits"))).sort()).toEqual([".before", "keep-1"]);
    expect(await readdir(b("lastmile", "main", "t1"))).toEqual(["c0"]);
    expect((await readdir(b("layout", "ws"))).sort()).toEqual(["base", "flow.json", "place", "rank", "route"]);
    expect(await readdir(b("release"))).toEqual(["bom", "vias"]);
    expect((await cleanPlan(dir, { keep: 3 })).remove).toEqual([]);
  });
});
