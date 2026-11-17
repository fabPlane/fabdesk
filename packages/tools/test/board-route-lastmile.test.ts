import { describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createRegistry, type CoreServices } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

const BOARD = `(kicad_pcb (version 20250114)
	(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
	(gr_rect (start 0 0) (end 40 30) (layer "Edge.Cuts"))
	(footprint "L:J1" (layer "F.Cu") (at 5 5) (property "Reference" "J1") (property "Value" "x")
		(pad "1" smd rect (at 0 0) (size 0.4 0.4) (layers "F.Cu") (net "USB_DP"))
		(pad "2" smd rect (at 0 0.9) (size 0.4 0.4) (layers "F.Cu") (net "USB_DN")))
	(footprint "L:U1" (layer "F.Cu") (at 25 5) (property "Reference" "U1") (property "Value" "y")
		(pad "1" smd rect (at 0 0) (size 0.4 0.4) (layers "F.Cu") (net "USB_DP"))
		(pad "2" smd rect (at 0 0.9) (size 0.4 0.4) (layers "F.Cu") (net "USB_DN")))
	(segment (start 5 5) (end 25 5) (width 0.15) (layer "F.Cu") (net "USB_DP") (uuid "a1b2c3d4-0000-4000-8000-000000000001"))
	(segment (start 5 5.9) (end 25 5.9) (width 0.15) (layer "F.Cu") (net "USB_DN") (uuid "a1b2c3d4-0000-4000-8000-000000000002"))
)`;
const PRO = JSON.stringify({
  net_settings: {
    classes: [{ name: "Default", track_width: 0.15, clearance: 0.13 }, { name: "USB", track_width: 0.15, diff_pair_width: 0.15, diff_pair_gap: 0.2 }],
    netclass_patterns: [{ pattern: "USB_*", netclass: "USB" }],
  },
  board: { design_settings: { rules: { min_track_width: 0.1, min_clearance: 0.1 } } },
});

async function setup(stem = "board") {
  const project = await tempProject("lm");
  await writeFile(join(project.dir, `${stem}.kicad_pcb`), BOARD);
  await writeFile(join(project.dir, `${stem}.kicad_pro`), PRO);
  const seen: Array<{ target: string; candidate: string }> = [];
  const empty = { removed: {}, added: {}, changed: {} };
  const services: CoreServices = {
    ...mockServices([project]),
    boardAdopt: { adopt: async (i) => (seen.push(i), { delta: empty, residual: empty, targetSha256Before: "a".repeat(64), targetSha256After: "b".repeat(64), timingsMs: {}, kicadCli: "kicad-cli" }) },
  };
  const def = createRegistry().get("board_route")!;
  const call = async (args: Record<string, unknown>) => {
    const ctx = await contextFactory(services, project)({ def, projectRef: undefined, signal: new AbortController().signal, progress: () => {} } as never);
    return def.handler({ why: true, side: "both", router: "fab_router", noAccept: false, slackA8: 0, maxRounds: 6, adopt: true, refresh: false, full: false, seeds: "0-7", all: false, until: "route", ...args } as never, ctx);
  };
  return { project, call, seen };
}

describe("board_route last-mile actions", () => {
  test("is a board-toolset tool with one action input covering layout and last mile", () => {
    const def = createRegistry().get("board_route")!;
    expect(def.toolset).toBe("board");
    expect(def.name).toBe("board_route");
  });

  test("new, pairs --why, try tighten (pair copper only), status, accept refused at the start, undo", async () => {
    const { project, call } = await setup();
    const n = await call({ action: "new" });
    expect(n.text).toContain("open 0");
    const m = await call({ action: "pairs" });
    expect(m.text).toContain("USB_DP / USB_DN");
    expect(m.text).toContain("share 0.00");
    const t = await call({ action: "try", actions: ["tighten"] });
    expect(t.text).toContain("ACCEPT");
    expect((t.json as { accepted: string }).accepted).toBe("tighten");
    const after = await call({ action: "pairs", why: false });
    expect(after.text).toMatch(/share (0\.9\d|1\.00)/); // tightened to the class spacing (jogs at the pads stay uncoupled)
    const st = await call({ action: "status" });
    expect(st.text).toContain("step 1 of 1");
    expect((st.json as { stage: string }).stage).toBe("lastmile");
    expect((await call({ action: "undo" })).text).toContain("step 0");
    await expect(call({ action: "undo" })).rejects.toThrow(/at the start board/);
    await expect(call({ action: "accept" })).rejects.toThrow(/nothing accepted yet/);
    // the project's own board is untouched by any of this
    expect(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")).toBe(BOARD);
  });

  test("fit dry-runs one nudge; KRT steps fail naming KRT when it is missing; view writes an SVG; unknown action names list the vocabulary", async () => {
    const { call } = await setup();
    await call({ action: "new" });
    await expect(call({ action: "fit" })).rejects.toThrow(/one nudge:\/turn: action/);
    const f = await call({ action: "fit", actions: ["nudge:U1@25,12~3"] });
    expect(f.text).toMatch(/U1|NO FIT/);
    const t = await call({ action: "try", actions: ["rip", "pairs-all", "replace:core"] });
    expect(t.text).toContain("KiCadRoutingTools");
    expect(t.text).toContain("replace (re-routing the region)");
    expect((t.json as { accepted: string | null }).accepted).toBeNull();
    const v = await call({ action: "view", box: [0, 0, 40, 30] });
    expect(String(v.text)).toMatch(/\.(svg|png)$/);
    await expect(call({ action: "try", actions: ["bogus"] })).rejects.toThrow(/unknown action 'bogus'/);
    const i = await call({ action: "info", items: ["J1", "^USB_DP$"] });
    expect(i.text).toContain("J1  x  at 5.00,5.00");
    expect(i.text).toContain("USB_DP  total 20.00 mm");
  });

  test("accept adopts onto the board the bench started from, not board.kicad_pcb", async () => {
    const { project, call, seen } = await setup("foo");
    await call({ action: "new" });
    expect((await call({ action: "try", actions: ["tighten"] })).text).toContain("ACCEPT");
    const r = await call({ action: "accept", reason: "tightened" });
    expect(seen.map((s) => s.target)).toEqual([join(project.dir, "foo.kicad_pcb")]);
    expect(r.text).toContain("foo.kicad_pcb");
    // where the adopted board stands against the workspace's start, so no hand DRC/diff is needed
    expect(r.text).toMatch(/Saved board now: open \d+ drc \d+.*Candidate score before adoption: open \d+/);
    expect(r.text).toContain("parts moved: none");
    expect((r.json as any).canonicalDrc.status).toBe("measured");
  });

  test("accept candidate: relative to the workspace, refused outside it (also through a symlink)", async () => {
    const { project, call } = await setup();
    const ws = join(project.dir, ".fabdesk/board/lastmile/main");
    await call({ action: "new" });
    const t = await call({ action: "try", actions: ["tighten"], noAccept: true });
    const dir = (t.json as { candidates: Array<{ dir?: string }> }).candidates[0]!.dir!;
    const rel = relative(ws, dir);
    expect(rel.startsWith("..")).toBe(false);
    const a = await call({ action: "accept", candidate: rel, adopt: false });
    expect(a.text).toContain("ACCEPT");
    // the path a try reports (project-relative or absolute) names the same folder
    const t2 = await call({ action: "try", actions: ["tighten"], noAccept: true });
    const dir2 = (t2.json as { candidates: Array<{ dir?: string }> }).candidates[0]!.dir!;
    // (resolved and judged by the gate: no gain over the board just accepted, not a path refusal)
    await expect(call({ action: "accept", candidate: relative(project.dir, dir2), adopt: false })).rejects.toThrow(/no gain/);
    await expect(call({ action: "accept", candidate: dir2, adopt: false })).rejects.toThrow(/no gain/);
    for (const bad of ["../../../..", "/etc", "../main-other"])
      await expect(call({ action: "accept", candidate: bad, adopt: false })).rejects.toThrow(/inside the workspace/);
    const outside = await mkdtemp(join(tmpdir(), "lm-outside-"));
    await cp(dir, outside, { recursive: true });
    await symlink(outside, join(ws, "escape"));
    await expect(call({ action: "accept", candidate: "escape", adopt: false })).rejects.toThrow(/inside the workspace/);
  });

  test("workspace stays under .fabdesk/board in the project, by real path; spec stays in the project", async () => {
    const { project, call } = await setup();
    for (const workspace of ["../elsewhere", "/tmp/ws", "lastmile-ws", ".fabdesk/other"])
      await expect(call({ action: "new", workspace })).rejects.toThrow(/project directory|under .fabdesk\/board/);
    const outside = await mkdtemp(join(tmpdir(), "ws-outside-"));
    await mkdir(join(project.dir, ".fabdesk", "board"), { recursive: true });
    await symlink(outside, join(project.dir, ".fabdesk", "board", "link"));
    await expect(call({ action: "new", workspace: ".fabdesk/board/link/ws" })).rejects.toThrow(/outside the project|under .fabdesk\/board/);
    await expect(call({ action: "check", spec: "../../etc/spec.json" })).rejects.toThrow(/escapes the project/);
    expect((await call({ action: "new", workspace: ".fabdesk/board/lastmile/alt" })).text).toContain("open 0");
  });
});

test("explicit revalidation keeps geometry across requirement refresh and refuses changed native inputs", async () => {
  const { project, call } = await setup();
  await call({ action: "new" });
  await call({ action: "try", actions: ["tighten"] });
  const path = join(project.dir, ".fabdesk/board/requirements/acceptance.json");
  const acceptance = JSON.parse(await readFile(path,"utf8")); acceptance.purpose = "rechecked requirements";
  await writeFile(path,JSON.stringify(acceptance));
  const validated = await call({ action: "revalidate" });
  expect(validated.text).toContain("revalidated");
  expect((validated.json as any).parity_checked).toBe(true);
  await writeFile(join(project.dir,"board.kicad_pcb"),BOARD + "\n");
  await expect(call({ action: "revalidate" })).rejects.toThrow("native design input changed");
});
