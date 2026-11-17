import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibFootprint } from "@fp-pcb/client";
import { createFpPcbDesign } from "./fp-pcb-design";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "project-library-")); dirs.push(dir);
  await mkdir(join(dir, "SHT31Pilot.pretty"));
  await writeFile(join(dir, "fp-lib-table"), '(fp_lib_table (lib (name "SHT31Pilot") (type "KiCad") (uri "${KIPRJMOD}/SHT31Pilot.pretty")))');
  const calls: string[] = [];
  const live = new LibFootprint();
  const session = { kicad: { projectInfo: async () => ({}), libraries: {
    entries: async (_kind: string, nickname: string, _filter: string) => { calls.push(nickname); return [{ name: "Sensor", description: "SHT31 sensor" }]; },
    get: async (_kind: string, id: string) => { calls.push(id); return live; },
    addTableRow: async (_kind: string, _scope: string, row: { uri: string }) => { calls.push(row.uri); },
  } } };
  const design = createFpPcbDesign({ bridge: () => ({}) as never,
    sessions: { withRetry: async (project: string, fn: (s: typeof session) => unknown) => { expect(project).toBe(dir); return fn(session); }, ensureProject: async () => ({}), preservingProjectLibraries: async (_dir: string, _session: unknown, fn: () => unknown) => fn() } as never,
    catalog: { has: () => true, search: async () => [
      { libId: "SHT31Pilot:Sensor", nickname: "SHT31Pilot", name: "Sensor", description: "wrong bundled copy" },
      { libId: "Bundled:Sensor", nickname: "Bundled", name: "Sensor", description: "bundled sensor" },
    ], describe: async () => { throw Error("must not consult bundled override"); } } as never,
  });
  return { dir, calls, design };
}
test("project search precedes catalog and shadows bundled nickname; describe uses project session", async () => {
  const f = await fixture();
  expect(await f.design.searchFootprints("Sensor", 10, f.dir)).toEqual([
    { libId: "SHT31Pilot:Sensor", nickname: "SHT31Pilot", name: "Sensor", description: "SHT31 sensor" },
    { libId: "Bundled:Sensor", nickname: "Bundled", name: "Sensor", description: "bundled sensor" },
  ]);
  expect(await f.design.describePart("footprint", "SHT31Pilot:Sensor", f.dir)).toMatchObject({ kind: "footprint", libId: "SHT31Pilot:Sensor" });
  expect(f.calls).toEqual(["SHT31Pilot", "SHT31Pilot:Sensor"]);
});
test("registration uses portable project URI and refuses traversal, external symlinks and wrong library types", async () => {
  const f = await fixture();
  expect(await f.design.registerLibrary!(f.dir, "footprint", "Pilot", "SHT31Pilot.pretty")).toEqual({ nickname: "Pilot", uri: "${KIPRJMOD}/SHT31Pilot.pretty" });
  const outside = await mkdtemp(join(tmpdir(), "outside-library-")); dirs.push(outside);
  await symlink(outside, join(f.dir, "escape.pretty"));
  for (const path of ["../escape.pretty", "escape.pretty", "missing.pretty", "fp-lib-table"])
    await expect(f.design.registerLibrary!(f.dir, "footprint", "Pilot", path)).rejects.toThrow();
  await expect(f.design.registerLibrary!(f.dir, "footprint", "../bad", "SHT31Pilot.pretty")).rejects.toThrow("nickname");
  expect(f.calls).toEqual(["${KIPRJMOD}/SHT31Pilot.pretty"]);
});
