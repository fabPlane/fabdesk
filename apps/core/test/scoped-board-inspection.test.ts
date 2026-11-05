import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { attachToRegistry, createRegistry, defineTool, inspectProjectBoardSources, toolRoutes, type JobsLike, type ToolOutput } from "@fabdesk/tools";
import { contextFactory, mockServices, tempProject } from "../../../packages/tools/test/mock-services";
import { createContextFactory } from "../src/context";
import { assertNativeBoardOwnership } from "../src/assembly-board-binding";
import type { ProjectStore } from "../src/projects";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(assembly = true) {
  const project = await tempProject("scoped-inspection"); roots.push(dirname(project.dir));
  const root = await realpath(project.dir), calls: string[] = [], services = mockServices([project]);
  await writeFile(join(root, "board.kicad_pcb"), "root source");
  if (assembly) {
    for (const id of ["a", "b"]) { await mkdir(join(root, "boards", id), { recursive: true }); await writeFile(join(root, "boards", id, "board.kicad_pcb"), `source ${id}`); }
    await writeFile(join(root, "fabplane.assembly.json"), JSON.stringify({ contract: "fabplane.assembly.v1", sources: ["a", "b"].map(id => ({ id, name: id, location: "project", directory: `boards/${id}` })), instances: ["a", "b"].map(id => ({ id, name: id, sourceId: id })), connections: [] }));
  }
  services.design.query = async dir => {
    await assertNativeBoardOwnership(dir); calls.push(dir);
    return [{ ref: dir.endsWith("/a") ? "RA" : dir.endsWith("/b") ? "RB" : "ROOT", x: 1, y: 2 }];
  };
  const projects = { isPromoting: () => false, resolve: async (ref: string) => ref === project.id ? project : null, handle: async (id: string) => id === project.id ? project : null } as unknown as ProjectStore;
  const factory = createContextFactory({ services, projects, tokens: null, defaultProject: async () => project });
  const inspection = await inspectProjectBoardSources(project), registry = createRegistry();
  const board = { sourceId: "a", manifestSha256: inspection.manifestSha256! };
  const invoke = (args: Record<string, unknown>) => registry.invoke("pcb_inspect", { project: project.id, kinds: ["components"], ...args }, (projectRef, def, board) => factory({ projectRef, def, ...(board ? { board } : {}), signal: new AbortController().signal, progress: () => {} }));
  return { project, root, calls, services, factory, registry, board, invoke };
}

test("explicit board inspection uses separate native directories while retaining root project ownership", async () => {
  const f = await fixture();
  for (const sourceId of ["a", "b"]) {
    const result = await f.invoke({ board: { ...f.board, sourceId } });
    expect(result.json).toMatchObject({ _board: { projectId: f.project.id, sourceId, manifestSha256: f.board.manifestSha256 }, revision: createHash("sha256").update(`source ${sourceId}`).digest("hex"), results: { components: { rows: [{ ref: sourceId === "a" ? "RA" : "RB" }] } } });
  }
  expect(f.calls).toEqual([join(f.root, "boards/a"), join(f.root, "boards/b")]);
  expect(await readFile(join(f.root, "board.kicad_pcb"), "utf8")).toBe("root source");
});
test("missing, stale and physical-instance selectors cannot fall back to a root PCB", async () => {
  const f = await fixture();
  await expect(f.invoke({})).rejects.toThrow("explicit assembly board source");
  await expect(f.invoke({ board: { ...f.board, manifestSha256: "0".repeat(64) } })).rejects.toThrow("membership changed");
  await expect(f.invoke({ board: { ...f.board, sourceId: "physical-instance-only" } })).rejects.toThrow("source is missing");
  expect(f.calls).toEqual([]);
  await expect(f.registry.invoke("pcb_define_outline", { board: f.board, widthMm: 10, heightMm: 10 }, () => { throw new Error("must not resolve unsupported input"); })).rejects.toThrow("invalid arguments");
});
test("unscoped and unsupported native member mutations cannot execute against an assembly root", async () => {
  const f = await fixture();
  let placed = false;
  f.services.design.placeFootprints = async () => { placed = true; throw new Error("Unexpected native placement"); };
  const run = (name: string, args: Record<string, unknown>) => f.registry.invoke(name, { project: f.project.id, ...args }, (projectRef, def, board) => f.factory({ projectRef, def, ...(board ? { board } : {}), signal: new AbortController().signal, progress: () => {} }));
  await expect(run("pcb_place", { placements: [{ reference: "R1", rotation: 90 }] })).rejects.toThrow("explicit assembly board source");
  await expect(run("pcb_define_outline", { widthMm: 10, heightMm: 10 })).rejects.toThrow("not yet board-scoped");
  expect(placed).toBe(false); expect(f.calls).toEqual([]);
  const status = await run("project_status", {});
  expect(status.json).toHaveProperty("assembly");
});
test("scoped handles freeze native destinations and reject parent-default metadata access", async () => {
  const f = await fixture(), ctx = await f.factory({ def: f.registry.get("pcb_inspect")!, projectRef: f.project.id, board: f.board, signal: new AbortController().signal, progress: () => {} });
  expect(Object.isFrozen(ctx.project)).toBe(true); expect(ctx.project?.id).toBe(f.project.id);
  expect(() => ctx.requireProject().manifest()).toThrow("not board-specific");
  await expect(ctx.requireProject().updateManifest({ name: "wrong parent" })).rejects.toThrow("parent project metadata");
  await writeFile(join(f.root, "fabplane.assembly.json"), "{}");
  await expect(ctx.runInScope!(async () => { await f.services.design.query(ctx.requireProject().dir, "components"); })).rejects.toThrow("ownership changed");
  expect(f.calls).toEqual([]);
});
test("legacy inspection remains unscoped and hosts that ignore board selection fail closed", async () => {
  const legacy = await fixture(false), result = await legacy.invoke({});
  expect(result.json).not.toHaveProperty("_board"); expect(legacy.calls).toEqual([legacy.project.dir]);
  const f = await fixture();
  await expect(f.registry.invoke("pcb_inspect", { kinds: ["components"], board: f.board }, (projectRef, def) => contextFactory(f.services, f.project)({ projectRef, def, signal: new AbortController().signal, progress: () => {} }))).rejects.toThrow("did not establish");
  expect(f.calls).toEqual([]);
});
test("HTTP sync and deferred jobs carry selectors and attribute work to the root project", async () => {
  const f = await fixture(), queued: Array<Parameters<JobsLike["enqueue"]>[0]> = [], executed: string[] = [];
  let observedSignal: AbortSignal | null = null;
  const jobs: JobsLike = { enqueue: job => { queued.push(job); return { id: `job-${queued.length}` }; } };
  f.registry.add(defineTool({ name: "scoped_probe", title: "Scoped probe", description: "Test source execution", toolset: "core", boardScoped: true, longRunning: true, inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, handler: async (_args, ctx) => { executed.push(ctx.requireProject().dir); observedSignal = ctx.signal; ctx.progress(.5); return { json: { dir: ctx.requireProject().dir } }; } }));
  const app = new Hono().route("/", toolRoutes({ registry: f.registry, ctxFactory: f.factory, jobs }));
  const request = (name: string, board = f.board) => app.request(`/tools/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: f.project.id, args: { kinds: ["components"], board } }) });
  const sync = await request("pcb_inspect"); expect(sync.status).toBe(200); expect(await sync.json()).toMatchObject({ ok: true, json: { _board: { sourceId: "a", projectId: f.project.id } } });
  const enqueue = async (sourceId: string) => app.request("/tools/scoped_probe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: f.project.id, args: { board: { ...f.board, sourceId } } }) });
  expect((await enqueue("b")).status).toBe(202); expect(queued[0]?.projectId).toBe(f.project.id);
  const signal = new AbortController().signal, progress: number[] = [];
  const completed = await queued[0]!.run({ signal, progress: value => { progress.push(value); } }) as ToolOutput;
  expect(observedSignal).toBe(signal); expect(progress).toEqual([.5]);
  expect(completed.json).toMatchObject({ dir: join(f.root, "boards/b"), _board: { projectId: f.project.id, sourceId: "b" } });
  expect((await enqueue("a")).status).toBe(202);
  const other = await fixture(), originalDir = f.project.dir;
  f.project.dir = other.project.dir;
  await expect(queued[1]!.run({ signal: new AbortController().signal, progress: () => {} })).rejects.toThrow("refusing to retarget");
  f.project.dir = originalDir;
  expect((await enqueue("a")).status).toBe(202);
  await writeFile(join(f.root, "fabplane.assembly.json"), "{}");
  await expect(queued[2]!.run({ signal: new AbortController().signal, progress: () => {} })).rejects.toThrow();
  expect(executed).toEqual([join(f.root, "boards/b")]);
});
test("deferred source operations retain the original directory identity, not a newly resolved copy", async () => {
  const f = await fixture();
  let queued: Parameters<JobsLike["enqueue"]>[0] | null = null, executed = false;
  f.registry.add(defineTool({ name: "queued_source", title: "Queued source", description: "Test original owner", toolset: "core", boardScoped: true, longRunning: true, inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, handler: async () => { executed = true; return { json: {} }; } }));
  const app = new Hono().route("/", toolRoutes({ registry: f.registry, ctxFactory: f.factory, jobs: { enqueue: job => { queued = job; return { id: "queued" }; } } }));
  const response = await app.request("/tools/queued_source", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: f.project.id, args: { board: f.board } }) });
  expect(response.status).toBe(202);
  const directory = join(f.root, "boards/a"); await rename(directory, `${directory}-old`); await cp(`${directory}-old`, directory, { recursive: true });
  await expect(queued!.run({ signal: new AbortController().signal, progress: () => {} })).rejects.toThrow("ownership changed");
  expect(executed).toBe(false);
});
test("direct MCP and capability dispatch preserve the same explicit source selector", async () => {
  const f = await fixture();
  for (const hidden of [false, true]) {
    const server = new McpServer({ name: "scope-test", version: "0" });
    attachToRegistry(server, f.registry, f.factory, { initialTools: hidden ? ["project_status"] : ["project_status", "pcb_inspect"] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "scope-client", version: "0" }); await client.connect(clientTransport);
    try {
      const sourceId = hidden ? "b" : "a", args = { project: f.project.id, kinds: ["components"], board: { ...f.board, sourceId } };
      if (hidden) await client.callTool({ name: "capability_search", arguments: { query: "pcb_inspect" } });
      if (!hidden) expect((await client.callTool({ name: "pcb_inspect", arguments: { project: f.project.id, kinds: ["components"] } })).isError).toBe(true);
      const result = await client.callTool(hidden ? { name: "capability_call", arguments: { name: "pcb_inspect", arguments: args } } : { name: "pcb_inspect", arguments: args });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ _board: { sourceId, projectId: f.project.id } });
    } finally { await client.close(); await server.close(); }
  }
  expect(f.calls).toEqual([join(f.root, "boards/a"), join(f.root, "boards/b")]);
});

test("explicit member preview export publishes only the chosen source and a matching receipt", async () => {
  const f = await fixture();
  for (const id of ["a", "b"]) { await mkdir(join(f.root, "boards", id, "renders")); await writeFile(join(f.root, "boards", id, "renders/pcb.svg"), `old ${id}`); }
  f.services.kicad.exportPcbSvg = async (_cli, options) => { expect(await readFile(options.board, "utf8")).toBe("source a"); await writeFile(options.output, "<svg viewBox=\"0 0 10 10\"/>"); return { paths: [options.output] }; };
  const result = await f.registry.invoke("render_pcb_svg", { project: f.project.id, board: f.board }, (projectRef, def, board) => f.factory({ projectRef, def, ...(board ? { board } : {}), signal: new AbortController().signal, progress: () => {} }));
  expect(result.json).toMatchObject({ _board: { projectId: f.project.id, sourceId: "a" } });
  const artifact = await readFile(join(f.root, "boards/a/renders/pcb.svg")), receipt = JSON.parse(await readFile(join(f.root, "boards/a/renders/pcb.svg.revision.json"), "utf8"));
  expect(receipt.sourceSha256).toBe(createHash("sha256").update("source a").digest("hex"));
  expect(receipt.artifactSha256).toBe(createHash("sha256").update(artifact).digest("hex"));
  expect(await readFile(join(f.root, "boards/b/renders/pcb.svg"), "utf8")).toBe("old b");
  expect(await readFile(join(f.root, "board.kicad_pcb"), "utf8")).toBe("root source");
});
test("membership changes during preview export preserve both the previous member image and receipt", async () => {
  const f = await fixture(), output = join(f.root, "boards/a/renders/pcb.svg"), receipt = `${output}.revision.json`;
  await mkdir(dirname(output)); await writeFile(output, "previous image"); await writeFile(receipt, "previous receipt");
  f.services.kicad.exportPcbSvg = async (_cli, options) => { await writeFile(options.output, "new image"); await writeFile(join(f.root, "fabplane.assembly.json"), "{}"); return { paths: [options.output] }; };
  await expect(f.registry.invoke("render_pcb_svg", { project: f.project.id, board: f.board }, (projectRef, def, board) => f.factory({ projectRef, def, ...(board ? { board } : {}), signal: new AbortController().signal, progress: () => {} }))).rejects.toThrow("ownership changed");
  expect(await readFile(output, "utf8")).toBe("previous image"); expect(await readFile(receipt, "utf8")).toBe("previous receipt");
});
test("member preview and receipt aliases cannot redirect publication into another source", async () => {
  for (const alias of ["directory", "receipt"]) {
    const f = await fixture();
    await mkdir(join(f.root, "boards/b/renders")); await writeFile(join(f.root, "boards/b/renders/pcb.svg"), "other image"); await writeFile(join(f.root, "boards/b/renders/pcb.svg.revision.json"), "other receipt");
    if (alias === "directory") await symlink(join(f.root, "boards/b/renders"), join(f.root, "boards/a/renders"));
    else { await mkdir(join(f.root, "boards/a/renders")); await symlink(join(f.root, "boards/b/renders/pcb.svg.revision.json"), join(f.root, "boards/a/renders/pcb.svg.revision.json")); }
    let exported = false;
    f.services.kicad.exportPcbSvg = async () => { exported = true; throw new Error("Unexpected export"); };
    await expect(f.registry.invoke("render_pcb_svg", { project: f.project.id, board: f.board }, (projectRef, def, board) => f.factory({ projectRef, def, ...(board ? { board } : {}), signal: new AbortController().signal, progress: () => {} }))).rejects.toThrow("outside");
    expect(exported).toBe(false); expect(await readFile(join(f.root, "boards/b/renders/pcb.svg"), "utf8")).toBe("other image"); expect(await readFile(join(f.root, "boards/b/renders/pcb.svg.revision.json"), "utf8")).toBe("other receipt");
  }
});


test("explicit member placement requires a source revision before reaching the native service", async () => {
  const f = await fixture(), called: string[] = [];
  const original = f.services.design.placeFootprints;
  f.services.design.placeFootprints = async (dir, placements, options) => { await assertNativeBoardOwnership(dir); called.push(dir); expect(options?.expectedSourceSha256).toBe("c".repeat(64)); return original(dir, placements, options); };
  const run = (args: Record<string, unknown>) => f.registry.invoke("pcb_place", { project: f.project.id, board: f.board, placements: [{ reference: "R1", rotation: 90 }], ...args }, (projectRef, def, board) => f.factory({ projectRef, def, ...(board ? { board } : {}), signal: new AbortController().signal, progress: () => {} }));
  await expect(run({})).rejects.toThrow("requires expectedSourceSha256"); expect(called).toEqual([]);
  const result = await run({ expectedSourceSha256: "c".repeat(64) });
  expect(result.json).toMatchObject({ saved: true, _board: { projectId: f.project.id, sourceId: "a", manifestSha256: f.board.manifestSha256 } });
  expect(called).toEqual([join(f.root, "boards/a")]);
  await expect(run({ board: { ...f.board, manifestSha256: "0".repeat(64) }, expectedSourceSha256: "c".repeat(64) })).rejects.toThrow("membership changed");
  expect(called).toHaveLength(1);
});
test("HTTP member resize retains the selected source, required source SHA and exact edge IDs", async () => {
  const f = await fixture(), calls: Array<{ dir: string; request: unknown }> = [], original = f.services.design.resizeBoardOutline;
  f.services.design.resizeBoardOutline = async (dir, request) => { await assertNativeBoardOwnership(dir); calls.push({ dir, request }); return original(dir, request); };
  const app = new Hono().route("/", toolRoutes({ registry: f.registry, ctxFactory: f.factory }));
  const args = { board: { ...f.board, sourceId: "b" }, edgeIds: ["edge-b"], widthMm: 20, heightMm: 15, expectedSourceSha256: "d".repeat(64) };
  const response = await app.request("/tools/pcb_resize_outline", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: f.project.id, args }) });
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ ok: true, json: { saved: true, _board: { sourceId: "b", projectId: f.project.id } } });
  expect(calls).toEqual([{ dir: join(f.root, "boards/b"), request: { edgeIds: ["edge-b"], widthMm: 20, heightMm: 15, expectedSourceSha256: "d".repeat(64) } }]);
  const invalid = await app.request("/tools/pcb_resize_outline", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: f.project.id, args: { ...args, expectedSourceSha256: undefined } }) });
  expect(invalid.status).toBe(400); expect(calls).toHaveLength(1);
});


test("mechanical workspace uses explicit paths without weakening assembly native guards", async () => {
  const f = await fixture();
  const run = (name: string, args: Record<string, unknown>) => f.registry.invoke(name, { project: f.project.id, ...args }, (projectRef, def, board) => f.factory({ projectRef, def, ...(board ? { board } : {}), signal: new AbortController().signal, progress: () => {} }));
  const status = await run("cad_fit", { action: "status" });
  expect(status.json).toMatchObject({ board: null, capabilities: { pcb: false } });
  // An explicit path reaches the revision guard, rather than inferring a canonical board.
  await expect(run("render_pcb_display", { boardPath: "boards/a/board.kicad_pcb", expectedPcbRevision: "0".repeat(64) })).rejects.toThrow("PCB changed");
  await expect(run("render_pcb_display", { boardPath: "../escape.kicad_pcb", expectedPcbRevision: "0".repeat(64) })).rejects.toThrow();
  await expect(run("cad_fit", { action: "edit_board" })).rejects.toThrow("supported explicit assembly board source");
  await expect(run("render_glb", {})).rejects.toThrow("explicit assembly board source");
  await expect(run("pcb_define_outline", { widthMm: 10, heightMm: 10 })).rejects.toThrow("not yet board-scoped");
  expect(await readFile(join(f.root, "board.kicad_pcb"), "utf8")).toBe("root source");
  expect(await readFile(join(f.root, "boards/a/board.kicad_pcb"), "utf8")).toBe("source a");
  expect(f.calls).toEqual([]);
});
