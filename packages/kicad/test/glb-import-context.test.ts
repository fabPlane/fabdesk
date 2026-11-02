import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exportGlb } from "../src/render";

test("GLB passes imported model root as one CLI argument and keeps stdout model diagnostics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fabdesk-glb-context-")), cli = join(dir, "kicad-cli"), output = join(dir, "board.glb");
  await writeFile(cli, `#!/usr/bin/env bun\nconst args=process.argv.slice(2); const out=args[args.indexOf('-o')+1]; await Bun.write(out, 'GLB'); await Bun.write(out+'.args', JSON.stringify(args)); console.log('Could not add 3D model for J2.'); console.error('Warning: model input missing');\n`);
  await chmod(cli, 0o755);
  try {
    const result = await exportGlb({ path: cli, version: "10" }, { board: join(dir, "board.kicad_pcb"), output, modelProjectDir: join(dir, "imported folder") });
    const args: string[] = JSON.parse(await readFile(output + ".args", "utf8"));
    expect(args[args.indexOf("--define-var") + 1]).toBe(`KIPRJMOD=${join(dir, "imported folder")}`);
    expect(result.warnings).toEqual(["Could not add 3D model for J2.", "Warning: model input missing"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
