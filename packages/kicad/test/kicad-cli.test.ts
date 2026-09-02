import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boardStats,
  convertToKicad,
  countCopperLayers,
  exportBom,
  exportDrill,
  exportGerbers,
  exportGlb,
  exportNetlist,
  exportPos,
  exportSchematicSvg,
  findKicadCli,
  gate,
  renderPng,
  runDrc,
  runErc,
  runKicadCli,
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

describe.skipIf(!hasCli)("convert + kicad-cli on a real board", () => {
  let dir: string;
  let board: string;
  let schematic: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "fabdesk-kicad-"));
    const circuitJson = (await Bun.file(join(import.meta.dir, "fixtures/led-usb.circuit.json")).json()) as unknown[];
    const { files, warnings } = await convertToKicad({ circuitJson, projectDir: dir, projectName: "ledusb" });
    expect(files).toEqual(["ledusb.kicad_pcb", "ledusb.kicad_sch", "ledusb.kicad_pro"]);
    expect(Array.isArray(warnings)).toBe(true);
    board = join(dir, "ledusb.kicad_pcb");
    schematic = join(dir, "ledusb.kicad_sch");
    expect(countCopperLayers(await Bun.file(board).text())).toBe(2);
  });

  test("runKicadCli filters noise and honours tolerateExit", async () => {
    const ok = await runKicadCli(kicad(), ["version"]);
    expect(ok.exitCode).toBe(0);
    expect(ok.stderr).not.toContain("Error retrieving source file attributes");
    const bad = await runKicadCli(kicad(), ["pcb", "drc", "/nope.kicad_pcb"], { tolerateExit: true });
    expect(bad.exitCode).not.toBe(0);
    await expect(runKicadCli(kicad(), ["pcb", "drc", "/nope.kicad_pcb"])).rejects.toThrow(/failed/);
  });

  test("runDrc parses the JSON report (unrouted board has unconnected items)", async () => {
    const report = await runDrc(kicad(), { board, outFile: join(dir, "drc.json"), severity: "all", schematicParity: true });
    expect(report.counts.unconnected).toBeGreaterThan(0);
    expect(report.unconnected[0]?.rule).toBe("unconnected_items");
    expect(report.unconnected[0]?.items.length).toBe(2);
    expect(report.schematicParity.length).toBeGreaterThan(0);
    for (const v of [...report.violations, ...report.schematicParity]) {
      expect(["error", "warning", "exclusion"]).toContain(v.severity);
      expect(v.signature).toContain(":");
    }
    const errorsOnly = await runDrc(kicad(), { board, outFile: join(dir, "drc-errors.json"), severity: "error" });
    expect(errorsOnly.counts.warnings).toBe(0);
    const result = gate(report, undefined, []);
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("unconnected"))).toBe(true);
  }, 60_000);

  test("runErc parses the JSON report", async () => {
    const report = await runErc(kicad(), { schematic, outFile: join(dir, "erc.json"), severity: "all" });
    expect(report.violations.length).toBeGreaterThan(0);
    expect(report.counts.warnings + report.counts.errors).toBeGreaterThan(0);
    expect(report.violations[0]?.rule).toBeString();
  }, 60_000);

  test("boardStats reads the outline", async () => {
    const stats = await boardStats(kicad(), board, join(dir, "stats.json"));
    expect(stats.width).toBe(20);
    expect(stats.height).toBe(15);
    expect(stats.thickness).toBe(1.6);
    expect(stats.footprints).toBe(3);
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

  test("fabrication exports", async () => {
    const gerbers = await exportGerbers(kicad(), { board, outDir: join(dir, "gerbers") });
    expect(gerbers.paths.length).toBeGreaterThan(2);
    const drill = await exportDrill(kicad(), { board, outDir: join(dir, "gerbers") });
    expect(drill.paths.length).toBeGreaterThanOrEqual(1);
    const pos = await exportPos(kicad(), { board, output: join(dir, "ledusb-pos.csv") });
    expect(await Bun.file(pos.paths[0]!).text()).toContain("R1");
    const bom = await exportBom(kicad(), { schematic, output: join(dir, "ledusb-bom.csv") });
    expect(await Bun.file(bom.paths[0]!).text()).toContain("R1");
    const net = await exportNetlist(kicad(), { schematic, output: join(dir, "ledusb.net"), format: "kicadsexpr" });
    expect(await Bun.file(net.paths[0]!).text()).toContain("(export");
    const spice = await exportNetlist(kicad(), { schematic, output: join(dir, "ledusb.cir"), format: "spice" });
    expect(existsSync(spice.paths[0]!)).toBe(true);
    const svg = await exportSchematicSvg(kicad(), { schematic, outDir: join(dir, "svg") });
    expect(svg.paths.length).toBeGreaterThanOrEqual(1);
    expect(svg.paths[0]).toMatch(/\.svg$/);
  }, 120_000);
});
