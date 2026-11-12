import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  finishItPrompt,
  inspectProject,
  milestoneDone,
  milestoneForTool,
  planMilestones,
  remainingMilestones,
  snapshotNote,
} from "./finish-it-plan";
import { boardChecksApply } from "./finish-it";

const NETLIST = {
  netlist: {
    components: [{ ref: "R1", value: "1k", footprint: "Resistor_SMD:R_0402_1005Metric" }],
    nets: [{ name: "N1", nodes: [{ ref: "R1", pin: "1" }] }],
  },
};

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "fabdesk-finish-it-"));
}

describe("inspectProject / planMilestones", () => {
  test("empty project needs every milestone", async () => {
    const dir = await tempDir();
    const snap = await inspectProject(dir);
    expect(snap).toMatchObject({
      hasNetlist: false,
      hasBoard: false,
      routed: false,
      drcErrors: null,
    });
    expect(planMilestones(snap).map((m) => [m.id, m.status])).toEqual([
      ["schematic", "pending"],
      ["build", "pending"],
      ["route", "pending"],
      ["verify", "pending"],
    ]);
    expect(remainingMilestones(planMilestones(snap))).toEqual([
      "schematic",
      "build",
      "route",
      "verify",
    ]);
  });

  test("skips completed prefix and keeps verify until DRC/ERC are clean", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "circuit.netlist.json"), JSON.stringify(NETLIST));
    await writeFile(join(dir, "board.kicad_pcb"), "(kicad_pcb (version 20240101))\n");
    await writeFile(join(dir, "board.kicad_sch"), "(kicad_sch (version 20240101))\n");
    await mkdir(join(dir, "reports"), { recursive: true });
    await writeFile(
      join(dir, "reports", "route.json"),
      JSON.stringify({ ok: true, open: 0 }),
    );
    await writeFile(
      join(dir, "reports", "drc.json"),
      JSON.stringify({ counts: { errors: 2, warnings: 0, unconnected: 1 } }),
    );
    const snap = await inspectProject(dir);
    expect(milestoneDone("schematic", snap)).toBe(true);
    expect(milestoneDone("build", snap)).toBe(true);
    expect(milestoneDone("route", snap)).toBe(true);
    expect(milestoneDone("verify", snap)).toBe(false);
    expect(remainingMilestones(planMilestones(snap))).toEqual(["verify"]);
    const running = planMilestones(snap).map((m) => (m.id === "verify" ? { ...m, status: "running" as const } : m));
    expect(remainingMilestones(running)).toEqual(["verify"]);
  });

  test("verify requires ERC when a schematic exists, and honors lastRoute", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "circuit.netlist.json"), JSON.stringify(NETLIST));
    await writeFile(join(dir, "board.kicad_pcb"), "(kicad_pcb)\n");
    await writeFile(join(dir, "board.kicad_sch"), "(kicad_sch)\n");
    await mkdir(join(dir, "reports"), { recursive: true });
    await writeFile(
      join(dir, "reports", "drc.json"),
      JSON.stringify({ counts: { errors: 0, warnings: 0, unconnected: 0 } }),
    );
    const withoutRoute = await inspectProject(dir);
    expect(milestoneDone("route", withoutRoute)).toBe(false);
    const withRoute = await inspectProject(dir, {
      lastRoute: { status: "completed", open: 0, applied: true },
    });
    expect(milestoneDone("route", withRoute)).toBe(true);
    expect(milestoneDone("verify", withRoute)).toBe(false);
    await writeFile(
      join(dir, "reports", "erc.json"),
      JSON.stringify({ counts: { errors: 0, warnings: 0 } }),
    );
    const clean = await inspectProject(dir, {
      lastRoute: { status: "completed", open: 0, applied: true },
    });
    expect(milestoneDone("verify", clean)).toBe(true);
    expect(remainingMilestones(planMilestones(clean))).toEqual([]);
  });

  test("ignores DRC/route reports older than the board", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "circuit.netlist.json"), JSON.stringify(NETLIST));
    await writeFile(join(dir, "board.kicad_pcb"), "(kicad_pcb old)\n");
    await mkdir(join(dir, "reports"), { recursive: true });
    await writeFile(join(dir, "reports", "route.json"), JSON.stringify({ ok: true, open: 0 }));
    await writeFile(
      join(dir, "reports", "drc.json"),
      JSON.stringify({ counts: { errors: 0, warnings: 0, unconnected: 0 } }),
    );
    const past = new Date(Date.now() - 120_000);
    const now = new Date();
    await utimes(join(dir, "reports", "route.json"), past, past);
    await utimes(join(dir, "reports", "drc.json"), past, past);
    await writeFile(join(dir, "board.kicad_pcb"), "(kicad_pcb moved footprint)\n");
    await utimes(join(dir, "board.kicad_pcb"), now, now);
    const snap = await inspectProject(dir);
    expect(milestoneDone("route", snap)).toBe(false);
    expect(milestoneDone("verify", snap)).toBe(false);
    expect(snap.drcErrors).toBeNull();
    expect(remainingMilestones(planMilestones(snap))).toEqual(["route", "verify"]);
  });

  test("build is incomplete when the netlist is newer than the board", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "board.kicad_pcb"), "(kicad_pcb old)\n");
    const past = new Date(Date.now() - 120_000);
    await utimes(join(dir, "board.kicad_pcb"), past, past);
    await writeFile(join(dir, "circuit.netlist.json"), JSON.stringify(NETLIST));
    const snap = await inspectProject(dir);
    expect(snap.hasBoard).toBe(false);
    expect(milestoneDone("build", snap)).toBe(false);
  });

  test("a git-checkout mtime skew of a few ms does not mark the board stale", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "board.kicad_pcb"), "(kicad_pcb)\n");
    await writeFile(join(dir, "circuit.netlist.json"), JSON.stringify(NETLIST));
    const t0 = Date.now();
    await utimes(join(dir, "board.kicad_pcb"), new Date(t0), new Date(t0));
    await utimes(join(dir, "circuit.netlist.json"), new Date(t0 + 40), new Date(t0 + 40));
    const snap = await inspectProject(dir);
    expect(snap.hasBoard).toBe(true);
    expect(milestoneDone("build", snap)).toBe(true);
  });

  test("ignores ERC older than the schematic", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "circuit.netlist.json"), JSON.stringify(NETLIST));
    await writeFile(join(dir, "board.kicad_pcb"), "(kicad_pcb)\n");
    await writeFile(join(dir, "board.kicad_sch"), "(kicad_sch old)\n");
    await mkdir(join(dir, "reports"), { recursive: true });
    await writeFile(
      join(dir, "reports", "drc.json"),
      JSON.stringify({ counts: { errors: 0, warnings: 0, unconnected: 0 } }),
    );
    await writeFile(join(dir, "reports", "erc.json"), JSON.stringify({ counts: { errors: 0 } }));
    const past = new Date(Date.now() - 120_000);
    await utimes(join(dir, "reports", "erc.json"), past, past);
    await writeFile(join(dir, "board.kicad_sch"), "(kicad_sch edited)\n");
    const snap = await inspectProject(dir, {
      lastRoute: { status: "completed", open: 0, applied: true },
    });
    expect(snap.ercErrors).toBeNull();
    expect(milestoneDone("verify", snap)).toBe(false);
  });

  test("a completed route that was not applied does not finish routing", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "circuit.netlist.json"), JSON.stringify(NETLIST));
    await writeFile(join(dir, "board.kicad_pcb"), "(kicad_pcb)\n");
    const snap = await inspectProject(dir, { lastRoute: { status: "completed", open: 0 } });
    expect(milestoneDone("route", snap)).toBe(false);
    const applied = await inspectProject(dir, {
      lastRoute: { status: "completed", open: 0, applied: true },
    });
    expect(milestoneDone("route", applied)).toBe(true);
  });

  test("final PCB connectivity proves routing after cleanup changes the router revision", async () => {
    const dir = await tempDir();
    const pcb = "(kicad_pcb final-cleanup)\n";
    await writeFile(join(dir, "circuit.netlist.json"), JSON.stringify(NETLIST));
    await writeFile(join(dir, "board.kicad_pcb"), pcb);
    await mkdir(join(dir, "reports"), { recursive: true });
    const report = {
      counts: { errors: 0, unconnected: 0 },
      schematicParityChecked: true,
      pcbRevision: { sha256: createHash("sha256").update(pcb).digest("hex") },
    };
    await writeFile(join(dir, "reports/drc.json"), JSON.stringify(report));
    const snap = await inspectProject(dir, {
      lastRoute: { status: "completed", open: 0, applied: true, pcbRevision: "old-router-revision" },
    });
    expect(remainingMilestones(planMilestones(snap))).toEqual([]);
    expect(snap.routeOpen).toBe(0);

    // A stale or incomplete check must never suppress real remaining work.
    for (const invalid of [
      { ...report, pcbRevision: { sha256: "different-board" } },
      { ...report, schematicParityChecked: false },
      { ...report, counts: { errors: 0, unconnected: 1 } },
    ]) {
      await writeFile(join(dir, "reports/drc.json"), JSON.stringify(invalid));
      expect((await inspectProject(dir)).routed).toBe(false);
    }
  });

  test("rejects a netlist that does not parse", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "circuit.netlist.json"), JSON.stringify({ not: "a netlist" }));
    const snap = await inspectProject(dir);
    expect(snap.hasNetlist).toBe(false);
    expect(milestoneDone("schematic", snap)).toBe(false);
  });
});

describe("milestoneForTool", () => {
  test("maps MCP and bare tool names", () => {
    expect(milestoneForTool("circuit_build")).toBe("build");
    expect(milestoneForTool("mcp__fabdesk__route_run")).toBe("route");
    expect(milestoneForTool("verify_drc")).toBe("verify");
    expect(milestoneForTool("verify_erc")).toBe("verify");
    expect(milestoneForTool("sim_run")).toBe("verify");
    expect(milestoneForTool("project_status")).toBeNull();
  });
});

describe("finishItPrompt", () => {
  test("lists remaining work and forbids step-by-step prompting", () => {
    const snap = {
      hasNetlist: true,
      netlistComponents: 1,
      hasBoard: false,
      hasSchematic: false,
      routed: false,
      routeOpen: null,
      drcErrors: null,
      drcUnconnected: null,
      ercErrors: null,
      spiceOk: null,
    };
    const prompt = finishItPrompt({
      projectName: "Blinky",
      snapshot: snap,
      remaining: ["build", "route", "verify"],
    });
    expect(prompt).toContain("Finish it mode");
    expect(prompt).toContain("Do not ask the user step-by-step");
    expect(prompt).toContain("circuit_build");
    expect(prompt).toContain("route_run");
    expect(prompt).toContain("verify_drc");
    expect(prompt).toContain("sim_run");
    expect(prompt).toContain("Place footprints");
    expect(prompt).not.toContain("Finish schematic");
    expect(snapshotNote("schematic", snap)).toContain("1 component");
  });
});

describe("Finish it with the board workflow's A1-A9", () => {
  const clean = {
    hasNetlist: true, netlistComponents: 3, hasBoard: true, hasSchematic: true,
    routed: true, routeOpen: 0, drcErrors: 0, drcUnconnected: 0, ercErrors: 0, spiceOk: null,
  };
  test("without the board workflow DRC/ERC counts decide, as before", () => {
    expect(milestoneDone("verify", clean)).toBe(true);
  });
  test("with the board workflow, clean DRC/ERC is not verified until A1-A9 pass on the saved board", () => {
    for (const state of ["none", "stale"] as const)
      expect(milestoneDone("verify", { ...clean, acceptance: { state, failing: [], pass: false, baselineFailing: [], regressions: [] } })).toBe(false);
    expect(milestoneDone("verify", { ...clean, acceptance: { state: "current", failing: ["A8"], pass: false, baselineFailing: [], regressions: ["A8"] } })).toBe(false);
    expect(milestoneDone("verify", { ...clean, acceptance: { state: "current", failing: [], pass: true, baselineFailing: [], regressions: [] } })).toBe(true);
  });
  test("a measured connectivity failure outranks an earlier route report", () => {
    expect(milestoneDone("route", { ...clean, acceptance: { state: "current", failing: ["A1_connectivity"], pass: false, baselineFailing: [], regressions: ["A1_connectivity"] } })).toBe(false);
    expect(milestoneDone("route", { ...clean, acceptance: { state: "stale", failing: ["A1_connectivity"], pass: false, baselineFailing: [], regressions: ["A1_connectivity"] } })).toBe(true);
  });
  test("verify note names what is failing; the board workflow tools count toward their milestones", () => {
    expect(snapshotNote("verify", { ...clean, acceptance: { state: "current", failing: ["A3", "A8"], pass: false, baselineFailing: [], regressions: ["A3", "A8"] } })).toContain("A1-A9 failing A3, A8");
    expect(milestoneForTool("mcp__fabdesk__board_route")).toBe("route");
    expect(milestoneForTool("board_check")).toBe("verify");
  });
  test("inspectProject reads the recorded acceptance only when asked", async () => {
    const dir = await tempDir();
    expect((await inspectProject(dir)).acceptance).toBeUndefined();
    expect((await inspectProject(dir, { boardChecks: true })).acceptance).toEqual({ state: "none", failing: [], pass: false, baselineFailing: [], regressions: [] });
  });
  test("a board that came in failing checks is done on no new failure, and the note says so", () => {
    const acc = { state: "current" as const, failing: ["A2", "A3"], pass: false, baselineFailing: ["A2", "A3", "A8"], regressions: [] };
    expect(milestoneDone("verify", { ...clean, acceptance: acc })).toBe(false);
    expect(milestoneDone("verify", { ...clean, acceptance: acc, doneMode: "no-regression" })).toBe(true);
    expect(snapshotNote("verify", { ...clean, acceptance: acc, doneMode: "no-regression" })).toContain("no new failure");
    expect(milestoneDone("verify", { ...clean, doneMode: "no-regression", acceptance: { ...acc, failing: ["A2", "A5"], regressions: ["A5"] } })).toBe(false);
  });
  test("the prompt names the board workflow stages and A1-A9 only when it is installed", () => {
    const input = { projectName: "p", snapshot: clean, remaining: ["verify" as const] };
    expect(finishItPrompt(input)).not.toContain("board workflow_");
    const p = finishItPrompt(input, { boardChecks: true });
    expect(p).toContain("board_check");
    expect(p).toContain("A1-A9 pass on the saved board");
  });
});

describe("Finish it review milestone", () => {
  const clean = {
    hasNetlist: true, netlistComponents: 3, hasBoard: true, hasSchematic: true,
    routed: true, routeOpen: 0, drcErrors: 0, drcUnconnected: 0, ercErrors: 0, spiceOk: null,
  };
  test("planned only where the board workflow can review; done only when the gate passes on the saved board", () => {
    expect(planMilestones(clean).map((m) => m.id)).toEqual(["schematic", "build", "route", "verify"]);
    const withReview = planMilestones({ ...clean, review: { state: "open", open: 3, mustFix: 1 } });
    expect(withReview.map((m) => m.id)).toEqual(["schematic", "build", "route", "verify", "review"]);
    expect(withReview.find((m) => m.id === "review")?.status).toBe("pending");
    expect(milestoneDone("review", { ...clean, review: { state: "pass" } })).toBe(true);
    for (const state of ["none", "stale", "open", "errors"] as const)
      expect(milestoneDone("review", { ...clean, review: { state } })).toBe(false);
    expect(milestoneDone("review", clean)).toBe(false);
  });
  test("notes and tools", () => {
    expect(snapshotNote("review", { ...clean, review: { state: "open", open: 1, mustFix: 1 } })).toBe("1 finding open (1 must-fix)");
    expect(snapshotNote("review", { ...clean, review: { state: "stale" } })).toContain("stale");
    expect(milestoneForTool("mcp__fabdesk__board_review")).toBe("review");
    expect(milestoneForTool("board_review")).toBe("review");
    expect(milestoneForTool("board_release")).toBe("verify");
  });
  test("the prompt carries the review step only with the board workflow", () => {
    const input = { projectName: "p", snapshot: clean, remaining: ["review" as const] };
    expect(finishItPrompt(input)).not.toContain("5. review");
    expect(finishItPrompt(input, { boardChecks: true })).toContain("5. review — run board_review (action run)");
  });
  test("the prompt names the right tool for each step", () => {
    const input = { projectName: "p", snapshot: clean, remaining: ["route" as const, "verify" as const, "review" as const] };
    const board = finishItPrompt(input, { boardChecks: true });
    expect(board).toContain("3. route — run board_route");
    expect(board).not.toContain("route_run");
    expect(board).toContain("board_review gate passes");
    expect(board).not.toContain("review checks (board_check)");
    // the board toolset is preloaded for a placed board: the text says so instead of asking for load_toolset first
    expect(board).toContain("already loaded");
    expect(board).not.toMatch(/Board workflow \(load_toolset/);
    const plain = finishItPrompt(input);
    expect(plain).toContain("3. route — run route_run");
    expect(plain).not.toContain("board_route");
    expect(plain).not.toContain("board_review");
    expect(plain).toContain("verify_drc");
  });
});

describe("Finish it board checks follow the project", () => {
  const ready = { workflowReady: true, settings: {} };
  const project = async (pcb: string | null) => {
    const dir = await tempDir();
    await writeFile(join(dir, "circuit.netlist.json"), JSON.stringify(NETLIST));
    if (pcb !== null) await writeFile(join(dir, "board.kicad_pcb"), pcb);
    return dir;
  };
  const plan = async (dir: string, opts: { workflowReady: boolean; settings: { boardChecksInFinishIt?: boolean } }) => {
    const boardChecks = await boardChecksApply(dir, opts);
    return { boardChecks, ids: planMilestones(await inspectProject(dir, { boardChecks })).map((m) => m.id) };
  };
  test("(a) a fresh circuit design (no board, or a blank board) keeps the DRC/ERC plan", async () => {
    expect(await plan(await project(null), ready)).toEqual({ boardChecks: false, ids: ["schematic", "build", "route", "verify"] });
    expect(await plan(await project("(kicad_pcb (version 20260831))\n"), ready)).toEqual({ boardChecks: false, ids: ["schematic", "build", "route", "verify"] });
  });
  test("(b) a placed board gets A1-A9 and the review milestone", async () => {
    const dir = await project("(kicad_pcb (footprint \"R\"))\n");
    const r = await plan(dir, ready);
    expect(r).toEqual({ boardChecks: true, ids: ["schematic", "build", "route", "verify", "review"] });
    expect((await inspectProject(dir, { boardChecks: true })).acceptance?.state).toBe("none");
    // without the board workflow registered, the placed board keeps the old plan too
    expect((await plan(dir, { workflowReady: false, settings: {} })).boardChecks).toBe(false);
  });
  test("(c) the setting turns it off for a placed board", async () => {
    const dir = await project("(kicad_pcb (footprint \"R\"))\n");
    expect(await plan(dir, { workflowReady: true, settings: { boardChecksInFinishIt: false } })).toEqual({ boardChecks: false, ids: ["schematic", "build", "route", "verify"] });
    expect((await plan(dir, { workflowReady: true, settings: { boardChecksInFinishIt: true } })).boardChecks).toBe(true);
  });
});

describe("Finish it on a board that came in failing checks (no new failure)", () => {
  const clean = {
    hasNetlist: true, netlistComponents: 3, hasBoard: true, hasSchematic: true,
    routed: false, routeOpen: 9, drcErrors: 3, drcUnconnected: 9, ercErrors: 4, spiceOk: null,
  };
  const acc = (failing: string[], regressions: string[]) => ({ state: "current" as const, failing, pass: false, baselineFailing: ["A1_connectivity", "A2_drc"], regressions });
  test("pre-existing opens and DRC/ERC findings do not keep route or verify pending", () => {
    const snap = { ...clean, doneMode: "no-regression" as const, acceptance: acc(["A1_connectivity", "A2_drc"], []) };
    expect(milestoneDone("route", snap)).toBe(true);
    expect(milestoneDone("verify", snap)).toBe(true);
  });
  test("a new connectivity failure still does, and so does strict mode", () => {
    expect(milestoneDone("route", { ...clean, doneMode: "no-regression", acceptance: acc(["A1_connectivity"], ["A1_connectivity"]) })).toBe(false);
    expect(milestoneDone("route", { ...clean, doneMode: "strict", acceptance: acc(["A1_connectivity"], []) })).toBe(false);
    expect(milestoneDone("verify", { ...clean, doneMode: "no-regression", acceptance: acc(["A5_anchors"], ["A5_anchors"]) })).toBe(false);
  });
});
