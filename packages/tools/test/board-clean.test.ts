/** board_route clean: dry run by default, apply deletes, refused while routing runs in the project. */
import { describe, expect, test } from "bun:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

describe("board_route clean", () => {
  test("lists, then deletes on apply; refuses apply while routing is active", async () => {
    const project = await tempProject("clean");
    await writeFile(join(project.dir, "board.kicad_pcb"), "(kicad_pcb)");
    const runs = join(project.dir, ".fabdesk", "board", "review", "runs");
    for (const r of ["20261101T0-a", "20261102T0-b", "20261103T0-c"]) {
      await mkdir(join(runs, r), { recursive: true });
      await writeFile(join(runs, r, "review.json"), "{}");
    }
    let routing = false;
    const base = mockServices([project]);
    const services = { ...base, routeRuns: { ...base.routeRuns, latest: () => (routing ? ({ state: "running" } as never) : null) } };
    const registry = createRegistry();
    const factory = contextFactory(services, project);
    const call = (args: Record<string, unknown>) => registry.invoke("board_route", args, (ref) => factory({ def: registry.get("board_route")!, projectRef: ref, signal: new AbortController().signal, progress: () => {} } as never)) as Promise<{ text: string; json: any }>;
    const dry = await call({ action: "clean", keep: 1 });
    expect(dry.text).toContain("Dry run (nothing deleted)");
    expect(dry.json.remove.map((r: { path: string }) => r.path)).toEqual([".fabdesk/board/review/runs/20261101T0-a", ".fabdesk/board/review/runs/20261102T0-b"]);
    expect(await readdir(runs)).toHaveLength(3);
    routing = true;
    await expect(call({ action: "clean", keep: 1, apply: true })).rejects.toThrow(/clean refused: routing is active/);
    routing = false;
    const done = await call({ action: "clean", keep: 1, apply: true });
    expect(done.json).toMatchObject({ applied: true, removed: 2 });
    expect(await readdir(runs)).toEqual(["20261103T0-c"]);
    expect((await call({ action: "clean" })).text).toContain("Nothing to clean");
  });
});
