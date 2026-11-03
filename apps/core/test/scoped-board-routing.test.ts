import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { link, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRegistry, inspectProjectBoardSources, type RouteRunRecord } from "@fabdesk/tools";
import { mockServices, tempProject } from "../../../packages/tools/test/mock-services";
import { createContextFactory } from "../src/context";
import { assertNativeBoardOwnership } from "../src/assembly-board-binding";
import type { ProjectStore } from "../src/projects";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const boardText = '(kicad_pcb (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (net "N1") (property "test" "source"))\n';
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
async function terminal(services: ReturnType<typeof mockServices>, id: string): Promise<RouteRunRecord> { for (let i = 0; i < 300; i++) { const run = services.routeRuns.get(id); if (run && ["completed", "failed", "cancelled"].includes(run.state)) return run; await Bun.sleep(5); } throw Error("route did not finish"); }
async function fixture() {
  const project = await tempProject("source-routing"), root = await realpath(project.dir); roots.push(dirname(root));
  await writeFile(join(root, "board.kicad_pcb"), "unrelated root");
  for (const id of ["a", "b"]) { await mkdir(join(root, "boards", id), { recursive: true }); await writeFile(join(root, "boards", id, "board.kicad_pcb"), boardText); await writeFile(join(root, "boards", id, "board.kicad_pro"), "{}\n"); }
  const manifest = { contract: "fabplane.assembly.v1", sources: ["a", "b"].map(id => ({ id, name: id, location: "project", directory: `boards/${id}` })), instances: ["a", "b"].map(id => ({ id, name: id, sourceId: id })), connections: [] };
  await writeFile(join(root, "fabplane.assembly.json"), JSON.stringify(manifest));
  const membership = await inspectProjectBoardSources(project), board = { sourceId: "a", manifestSha256: membership.manifestSha256! };
  const services = mockServices([project]), registry = createRegistry(), queried: string[] = [];
  const query = services.design.query, route = services.design.route;
  services.design.query = async (dir, ...args) => { await assertNativeBoardOwnership(dir); queried.push(dir); return query(dir, ...args); };
  services.design.route = async (dir, ...args) => { await assertNativeBoardOwnership(dir); const result = await route(dir, ...args); await writeFile(join(dir, "board.kicad_pcb"), boardText.replace('"source"', '"candidate"')); return result; };
  const factory = createContextFactory({ services, projects: { isPromoting: () => false, resolve: async () => project } as unknown as ProjectStore, tokens: null });
  const invoke = (name: string, args: Record<string, unknown>, source = board) => registry.invoke(name, { project: project.id, board: source, ...args }, (projectRef, def, selected) => factory({ projectRef, def, ...(selected ? { board: selected } : {}), signal: new AbortController().signal, progress: () => {} }));
  return { project, root, services, board, queried, invoke };
}
test("manual member candidate uses only its approved copy and cannot apply to a sibling, even idempotently", async () => {
  const f = await fixture();
  const started = await f.invoke("route_run", { router: "fab_router", applyPolicy: "manual", expectedSourceSha256: digest(boardText), waitMs: 0 });
  const id = (started.json as { runId: string }).runId, run = await terminal(f.services, id);
  expect(run.state).toBe("completed"); expect(run.candidate.available).toBe(true); expect(run.board).toEqual(f.board); expect(run.sourceDirectory).toBe("boards/a");
  expect(await readFile(join(f.root, "boards/a/board.kicad_pcb"), "utf8")).toBe(boardText);
  expect(f.queried.every(dir => dir === join(f.root, "boards/a") || dir === join(f.root, "boards/a/.fabdesk/runs", id, "snapshot"))).toBe(true);
  const other = { ...f.board, sourceId: "b" };
  await expect(f.invoke("route_apply", { runId: id, expectedPcbRevision: run.startingPcbRevision }, other)).rejects.toThrow("different board source");
  await f.invoke("route_apply", { runId: id, expectedPcbRevision: run.startingPcbRevision });
  await expect(f.invoke("route_apply", { runId: id, expectedPcbRevision: run.startingPcbRevision }, other)).rejects.toThrow("different board source");
  expect(await readFile(join(f.root, "boards/a/board.kicad_pcb"), "utf8")).toContain('"candidate"');
  expect(await readFile(join(f.root, "boards/b/board.kicad_pcb"), "utf8")).toBe(boardText);
  expect(await readFile(join(f.root, "board.kicad_pcb"), "utf8")).toBe("unrelated root");
  expect(f.services.events.find(event => event.topic === "project.changed")).toMatchObject({ projectId: f.project.id, paths: ["boards/a/board.kicad_pcb"] });
});
test("member routing rejects implicit auto apply, stale PCB and changed native rule inputs", async () => {
  const f = await fixture();
  await expect(f.invoke("route_run", { router: "fab_router", expectedSourceSha256: digest(boardText) })).rejects.toThrow("manual candidate");
  await expect(f.invoke("route_run", { router: "fab_router", applyPolicy: "manual", expectedSourceSha256: "0".repeat(64) })).rejects.toThrow("changed");
  const started = await f.invoke("route_run", { router: "fab_router", applyPolicy: "manual", expectedSourceSha256: digest(boardText), waitMs: 0 });
  const id = (started.json as { runId: string }).runId, run = await terminal(f.services, id);
  await writeFile(join(f.root, "boards/a/board.kicad_pro"), '{"changed":true}\n');
  const status = await f.invoke("route_status", { runId: id });
  expect((status.json as { run: { canonicalMatchesStart: boolean } }).run.canonicalMatchesStart).toBe(false);
  await expect(f.invoke("route_apply", { runId: id, expectedPcbRevision: run.startingPcbRevision })).rejects.toThrow("routing rules");
  expect(await readFile(join(f.root, "boards/a/board.kicad_pcb"), "utf8")).toBe(boardText);
});
test("a queued run whose captured membership changes becomes failed instead of staying running", async () => {
  const f = await fixture(); let queued: ((signal: AbortSignal) => Promise<void>) | undefined;
  f.services.routeTasks.enqueue = (_input, task) => { queued = task; return "queued"; };
  const started = await f.invoke("route_run", { router: "fab_router", applyPolicy: "manual", expectedSourceSha256: digest(boardText), waitMs: 0 });
  const id = (started.json as { runId: string }).runId;
  await writeFile(join(f.root, "fabplane.assembly.json"), "{}\n");
  await queued!(new AbortController().signal);
  expect(f.services.routeRuns.get(id)?.state).toBe("failed");
  expect(f.services.routeRuns.get(id)?.candidate.available).toBe(false);
  expect(await readFile(join(f.root, "boards/a/board.kicad_pcb"), "utf8")).toBe(boardText);
});


test("a member run refuses an aliased artifacts directory before writing sibling files", async () => {
  const f = await fixture();
  const sibling = join(f.root, "boards/b");
  await symlink(sibling, join(f.root, "boards/a/.fabdesk"));
  await expect(f.invoke("route_run", { router: "fab_router", applyPolicy: "manual", expectedSourceSha256: digest(boardText), waitMs: 0 })).rejects.toThrow("Routing artifact");
  expect((await readdir(sibling)).sort()).toEqual(["board.kicad_pcb", "board.kicad_pro"]);
});

test("publishing a private candidate never overwrites a hard-linked sibling source", async () => {
  const f = await fixture(), route = f.services.design.route;
  f.services.design.route = async (dir, ...args) => {
    const result = await route(dir, ...args);
    await link(join(f.root, "boards/b/board.kicad_pcb"), join(dirname(dir), "candidate.kicad_pcb"));
    return result;
  };
  const started = await f.invoke("route_run", { router: "fab_router", applyPolicy: "manual", expectedSourceSha256: digest(boardText), waitMs: 0 });
  await terminal(f.services, (started.json as { runId: string }).runId);
  expect(await readFile(join(f.root, "boards/b/board.kicad_pcb"), "utf8")).toBe(boardText);
  expect(await readFile(join(f.root, "boards/a/board.kicad_pcb"), "utf8")).toBe(boardText);
});


test("Apply refuses a candidate replaced by a hard-link even when its bytes match", async () => {
  const f = await fixture();
  const started = await f.invoke("route_run", { router: "fab_router", applyPolicy: "manual", expectedSourceSha256: digest(boardText), waitMs: 0 });
  const run = await terminal(f.services, (started.json as { runId: string }).runId);
  const candidate = join(f.root, "boards/a", run.candidate.path), sibling = join(f.root, "boards/b/board.kicad_pcb");
  const bytes = await readFile(candidate);
  await writeFile(sibling, bytes); await rm(candidate); await link(sibling, candidate);
  await expect(f.invoke("route_apply", { runId: run.id, expectedPcbRevision: run.startingPcbRevision })).rejects.toThrow("hard-link aliases");
  expect(await readFile(join(f.root, "boards/a/board.kicad_pcb"), "utf8")).toBe(boardText);
  expect(await readFile(sibling)).toEqual(bytes);
});
