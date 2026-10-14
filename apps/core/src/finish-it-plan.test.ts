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
    const withRoute = await inspectProject(dir, { lastRoute: { status: "completed", open: 0 } });
    expect(milestoneDone("route", withRoute)).toBe(true);
    expect(milestoneDone("verify", withRoute)).toBe(false);
    await writeFile(
      join(dir, "reports", "erc.json"),
      JSON.stringify({ counts: { errors: 0, warnings: 0 } }),
    );
    const clean = await inspectProject(dir, { lastRoute: { status: "completed", open: 0 } });
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
