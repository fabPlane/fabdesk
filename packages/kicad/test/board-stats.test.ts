import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardStats, supportsBoardStats, KicadCliError } from "../src/index";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(supported: boolean, failure?: "probe" | "export") {
  const dir = await mkdtemp(join(tmpdir(), "fabdesk-stats-capability-"));
  dirs.push(dir);
  const path = join(dir, "kicad-cli");
  const calls = join(dir, "calls.jsonl");
  const output = join(dir, "stats.json");
  await Bun.write(
    path,
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
await Bun.write(${JSON.stringify(calls)}, (await Bun.file(${JSON.stringify(calls)}).exists() ? await Bun.file(${JSON.stringify(calls)}).text() : "") + JSON.stringify(args) + "\\n");
if (args.includes("--help")) {
  if (${failure === "probe"}) { console.error("cannot load runtime"); process.exit(3); }
  console.log(${JSON.stringify("Usage: export [--help] {gerbers,svg" + (supported ? ",stats" : "") + "}\nSubcommands:\n  gerbers    Export Gerbers\n  svg        Export SVG\n" + (supported ? "  stats      Export board statistics\n" : ""))});
} else {
  if (${failure === "export"}) { console.error("Unable to load board file"); process.exit(4); }
  await Bun.write(args[args.indexOf("-o") + 1], JSON.stringify({
    board: {width: "15.000 mm", height: "15.000 mm", board_thickness: "1.600 mm", min_track_width: "2147.4836 mm"},
    components: {total: {front: 2, back: 1, total: 3}}
  }));
}
`,
  );
  await chmod(path, 0o755);
  return { cli: { path, version: "10.99.0" }, output, calls };
}

describe("optional pcb export stats capability", () => {
  test("an unsupported 10.99 build gives clear guidance without exporting or replacing a report", async () => {
    const f = await fixture(false);
    expect(await supportsBoardStats(f.cli)).toBe(false);
    await Bun.write(f.output, "previous report");
    await expect(boardStats(f.cli, "board.kicad_pcb", f.output)).rejects.toThrow(
      "does not provide 'pcb export stats'",
    );
    expect(await Bun.file(f.output).text()).toBe("previous report");
    const calls = (await Bun.file(f.calls).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.every((args) => args.includes("--help"))).toBe(true);
  });
  test("a supported build exports, normalizes and returns measured statistics", async () => {
    const f = await fixture(true);
    expect(await boardStats(f.cli, "board.kicad_pcb", f.output)).toEqual({
      width: 15,
      height: 15,
      thickness: 1.6,
      footprints: 3,
      frontFootprints: 2,
      backFootprints: 1,
    });
    expect((await Bun.file(f.output).json()).board.min_track_width).toBeNull();
  });
  test("a broken CLI probe remains a runtime error, not an unsupported capability", async () => {
    const f = await fixture(false, "probe");
    await expect(boardStats(f.cli, "board.kicad_pcb", f.output)).rejects.toBeInstanceOf(
      KicadCliError,
    );
  });
  test("a supported export that fails retains the real board error", async () => {
    const f = await fixture(true, "export");
    await expect(boardStats(f.cli, "board.kicad_pcb", f.output)).rejects.toThrow(
      "Unable to load board file",
    );
  });
});
