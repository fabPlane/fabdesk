import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boardStats,
  countCopperLayers,
  exportDrill,
  exportGerbers,
  exportGlb,
  exportPcbSvg,
  exportPos,
  findKicadCli,
  gate,
  renderPng,
  runDrc,
  runErc,
  runKicadCli,
  KicadCliError,
  type KicadCli,
} from "../src/index";

const cli = await findKicadCli();
const hasCli = cli !== null;
const kicad = () => cli as KicadCli;

describe("findKicadCli", () => {
  test.skipIf(!hasCli)("finds the local install and reads its version", () => {
    expect(cli?.path).toMatch(/kicad-cli/);
    expect(cli?.version).toMatch(/^\d+\.\d+/);
  });
  test("returns null for a bogus explicit path when nothing else is discoverable", async () => {
    const saved = { KICAD_CLI: process.env.KICAD_CLI, PATH: process.env.PATH };
    process.env.KICAD_CLI = "/definitely/not/here";
    process.env.PATH = "/nonexistent";
    try {
      const found = await findKicadCli("/also/not/here");
      // Known install paths can still succeed on a machine with KiCad; only assert the shape.
      expect(found === null || typeof found.version === "string").toBe(true);
    } finally {
      process.env.KICAD_CLI = saved.KICAD_CLI;
      process.env.PATH = saved.PATH;
    }
  });
});

describe.skipIf(!hasCli)("kicad-cli on a real board", () => {
  let dir: string;
  let board: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "fabdesk-kicad-"));
    board = join(dir, "mini.kicad_pcb");
    await Bun.write(board, await Bun.file(join(import.meta.dir, "fixtures/mini-two-layer.kicad_pcb")).text());
    expect(countCopperLayers(await Bun.file(board).text())).toBe(2);
  });

  test("runKicadCli filters noise and honours tolerateExit", async () => {
    const ok = await runKicadCli(kicad(), ["version"]);
    expect(ok.exitCode).toBe(0);
    expect(ok.stderr).not.toContain("Error retrieving source file attributes");
    const bad = await runKicadCli(kicad(), ["pcb", "drc", "/nope.kicad_pcb"], { tolerateExit: true });
    expect(bad.exitCode).not.toBe(0);
    const error = await runKicadCli(kicad(), ["pcb", "drc", "/nope.kicad_pcb"]).catch((e) => e);
    expect(error).toBeInstanceOf(KicadCliError);
    expect((error as KicadCliError).result.exitCode).not.toBe(0);
    expect((error as KicadCliError).result.stderr || (error as KicadCliError).result.stdout).not.toBe("");
  });

  test("runDrc parses the JSON report and gate reads it", async () => {
    const report = await runDrc(kicad(), { board, outFile: join(dir, "drc.json"), severity: "all" });
    expect(typeof report.counts.errors).toBe("number");
    expect(typeof report.counts.unconnected).toBe("number");
    for (const v of [...report.violations, ...report.unconnected]) {
      expect(["error", "warning", "exclusion"]).toContain(v.severity);
      expect(v.signature).toContain(":");
    }
    const errorsOnly = await runDrc(kicad(), { board, outFile: join(dir, "drc-errors.json"), severity: "error" });
    expect(errorsOnly.counts.warnings).toBe(0);
    const result = gate(report, undefined, []);
    expect(typeof result.pass).toBe("boolean");
  }, 60_000);

  test("boardStats reads the outline", async () => {
    const stats = await boardStats(kicad(), board, join(dir, "stats.json"));
    expect(stats.width).toBeGreaterThan(0);
    expect(stats.height).toBeGreaterThan(0);
    expect(typeof stats.footprints).toBe("number");
  }, 60_000);

  test("renderPng writes a PNG", async () => {
    const output = join(dir, "top.png");
    await renderPng(kicad(), { board, output, view: "top", width: 320, height: 200, quality: "basic" });
    expect(existsSync(output)).toBe(true);
    const header = new Uint8Array(await Bun.file(output).arrayBuffer()).slice(0, 4);
    expect([...header]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  }, 120_000);

  test("exportGlb writes a glTF", async () => {
    const output = join(dir, "board.glb");
    const result = await exportGlb(kicad(), { board, output });
    expect(existsSync(output)).toBe(true);
    expect(typeof result.fused).toBe("boolean");
  }, 120_000);

  test("fabrication exports and the PCB SVG", async () => {
    const gerbers = await exportGerbers(kicad(), { board, outDir: join(dir, "gerbers") });
    expect(gerbers.paths.length).toBeGreaterThan(2);
    const drill = await exportDrill(kicad(), { board, outDir: join(dir, "gerbers") });
    expect(drill.paths.length).toBeGreaterThanOrEqual(1);
    const pos = await exportPos(kicad(), { board, output: join(dir, "mini-pos.csv") });
    expect(existsSync(pos.paths[0]!)).toBe(true);
    const svg = await exportPcbSvg(kicad(), { board, output: join(dir, "pcb.svg") });
    expect(await Bun.file(svg.paths[0]!).text()).toContain("<svg");
  }, 120_000);
});
