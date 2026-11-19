import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exportGlb } from "../src/render";

test("GLB passes imported model root as one CLI argument and keeps stdout model diagnostics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fabdesk-glb-context-")), cli = join(dir, "kicad-cli"), output = join(dir, "board.glb");
  await writeFile(join(dir, "board.kicad_pcb"), "(kicad_pcb)");
  // The exporter now validates GLB framing and publishes from an isolated directory.
  const document = JSON.stringify({ asset: { version: "2.0" } });
  const json = Buffer.from(document.padEnd(Math.ceil(document.length / 4) * 4, " "));
  const fixture = Buffer.alloc(20 + json.length);
  fixture.writeUInt32LE(0x46546c67, 0);
  fixture.writeUInt32LE(2, 4);
  fixture.writeUInt32LE(fixture.length, 8);
  fixture.writeUInt32LE(json.length, 12);
  fixture.writeUInt32LE(0x4e4f534a, 16);
  json.copy(fixture, 20);
  let args: string[] = [];
  const previous = process.env["KICAD10_3DMODEL_DIR"];
  process.env["KICAD10_3DMODEL_DIR"] = join(dir, "model library with spaces");
  try {
    const result = await exportGlb({ path: cli, version: "10", trace: async input => {
      args = input.command.slice(1);
      await writeFile(args[args.indexOf("-o") + 1]!, fixture);
      return { stdout: "Could not add 3D model for J2.", stderr: "Warning: model input missing", exitCode: 0 };
    } }, { board: join(dir, "board.kicad_pcb"), output, modelProjectDir: join(dir, "imported folder") });
    // Surface detail must survive into the saved artifact, not just the viewer.
    for (const flag of ["--include-pads", "--include-tracks", "--include-zones", "--include-silkscreen", "--include-soldermask"]) expect(args).toContain(flag);
    expect(args).not.toContain("--include-inner-copper");
    const definitions = args.flatMap((arg, index) => arg === "--define-var" ? [args[index + 1]] : []);
    expect(definitions).toContain(`KIPRJMOD=${join(dir, "imported folder")}`);
    expect(definitions).toContain(`KICAD10_3DMODEL_DIR=${join(dir, "model library with spaces")}`);
    expect(definitions.every(value => /^(KIPRJMOD|KICAD\d+_3DMODEL_DIR)=/.test(value ?? ""))).toBe(true);
    expect(result.warnings).toEqual(["Could not add 3D model for J2.", "Warning: model input missing"]);
  } finally {
    if (previous === undefined) delete process.env["KICAD10_3DMODEL_DIR"]; else process.env["KICAD10_3DMODEL_DIR"] = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
