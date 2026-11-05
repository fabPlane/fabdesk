import { expect } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { inspectSchematicHierarchy, type KicadCli } from "../src";
export async function ownedPreviewFixture(native = false) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "fabplane-owned-svg-")));
  const empty = '(kicad_sch (version 20250114) (generator "eeschema") (uuid "00000000-0000-0000-0000-000000000001") (paper "A4") (lib_symbols))';
  const sheet = '(sheet (at 50 50) (size 25 15) (uuid "00000000-0000-0000-0000-000000000002") (property "Sheetname" "Child" (at 50 49.3 0) (effects (font (size 1.27 1.27)))) (property "Sheetfile" "child.kicad_sch" (at 50 65.7 0) (effects (font (size 1.27 1.27)))))';
  await writeFile(join(dir, "board.kicad_sch"), empty.slice(0, -1) + sheet + ")"); await writeFile(join(dir, "child.kicad_sch"), empty.replace("000000000001", "000000000003"));
  await writeFile(join(dir, "board.kicad_pro"), "{}");
  let svgCalls = 0, mutate: (() => Promise<void>) | null = null;
  const cli: KicadCli = native ? { path: process.env["FABPLANE_KICAD_CLI"]!, version: "10.99.0" } : { path: process.execPath, version: "10.99.0", trace: async ({ command }) => {
    const output = command[command.indexOf("-o") + 1]!, source = command.at(-1)!;
    expect(source.startsWith(dir)).toBe(false);
    if (command.includes("netlist")) await writeFile(output, '<export><design><sheet number="1" name="/" tstamps="/"/><sheet number="2" name="/Child/" tstamps="/00000000-0000-0000-0000-000000000002/"/></design><components></components><nets></nets></export>');
    else {
      svgCalls++; expect(await readFile(join(dirname(source), "child.kicad_sch"), "utf8")).toContain("000000000003");
      await mkdir(output, { recursive: true }); for (const name of (command.includes("--pages") ? [command[command.indexOf("--pages") + 1] === "2" ? "child.svg" : "root.svg"] : ["root.svg", "child.svg"])) await writeFile(join(output, name), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="2" y="10">Native test sheet</text></svg>');
      await mutate?.();
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  } };
  const inspect = () => inspectSchematicHierarchy(cli, { projectDir: dir, rootSchematic: join(dir, "board.kicad_sch"), ownedFilesOnly: true });
  return { dir, cli, inspect, svgCalls: () => svgCalls, mutate: (next: typeof mutate) => { mutate = next; } };
}
