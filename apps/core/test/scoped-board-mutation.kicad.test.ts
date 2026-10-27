import { describe, expect, test } from "bun:test";
import { cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { createRegistry, inspectProjectBoardSources } from "@fabdesk/tools";
import { contextFactory, mockServices, tempProject } from "../../../packages/tools/test/mock-services";
import { createContextFactory } from "../src/context";
import { createFpPcbDesign } from "../src/fp-pcb-design";
import { FpPcbSessions, type ProjectSession } from "../src/fp-pcb-session";
import type { ProjectStore } from "../src/projects";
import { haveKicad, startKiCad, type RunningKiCad } from "../../../vendor/fab_pcb/packages/client/test/kicad-server";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
describe.skipIf(!haveKicad())("explicit native member mutations", () => {
  test("placement and rectangular resize save only the selected member with guarded revisions and preserved copper", async () => {
    const project = await tempProject("member-mutation"), root = await realpath(project.dir), servers = new Map<string, RunningKiCad>();
    const registry = createRegistry(), services = mockServices([project]);
    const paths = [join(root, "boards/a/board.kicad_pcb"), join(root, "boards/b/board.kicad_pcb")];
    const declaration = join(root, "fabplane.assembly.json");
    try {
      for (const path of paths) { await mkdir(dirname(path), { recursive: true }); await cp(join(import.meta.dir, "../../../packages/kicad/test/fixtures/mini-two-layer.kicad_pcb"), path); }
      await writeFile(join(root, "board.kicad_pcb"), "Unrelated project root must remain unchanged");
      await writeFile(declaration, JSON.stringify({ contract: "fabplane.assembly.v1", sources: ["a", "b"].map(id => ({ id, name: id, location: "project", directory: `boards/${id}` })), instances: [{ id: "left", name: "Left", sourceId: "a" }, { id: "right", name: "Right", sourceId: "a" }, { id: "b", name: "Other", sourceId: "b" }], connections: [] }));
      const manifest = await readFile(declaration), other = await readFile(paths[1]!);
      const sessions = new FpPcbSessions(() => ({}) as never);
      sessions.session = async dir => {
        const path = join(dir, "board.kicad_pcb"); let server = servers.get(dir);
        if (!server) { server = await startKiCad(path, "fabplane-member-mutation"); servers.set(dir, server); }
        return { kicad: server.kicad, path } as unknown as ProjectSession;
      };
      const design = createFpPcbDesign({ bridge: () => ({}) as never, sessions }); services.design = design;
      const projects = { resolve: async () => project, handle: async () => project } as unknown as ProjectStore;
      const factory = createContextFactory({ services, projects, tokens: null });
      const membership = await inspectProjectBoardSources(project), board = { sourceId: "a", manifestSha256: membership.manifestSha256! };
      const run = (name: string, args: Record<string, unknown>) => registry.invoke(name, { project: project.id, board, ...args }, (projectRef, def, selector) => factory({ projectRef, def, ...(selector ? { board: selector } : {}), signal: new AbortController().signal, progress: () => {} }));
      const original = await readFile(paths[0]!), initialHash = sha(original), dir = join(root, "boards/a");
      await expect(run("pcb_place", { placements: [{ reference: "R1", rotation: 90 }] })).rejects.toThrow("requires expectedSourceSha256"); expect(servers.size).toBe(0);
      await expect(run("pcb_place", { placements: [{ reference: "R1", rotation: 90 }], expectedSourceSha256: "0".repeat(64) })).rejects.toThrow("PCB changed"); expect(servers.size).toBe(0);
      const inspection = await run("pcb_inspect", { kinds: ["components", "board_geometry"] });
      expect(inspection.json).toMatchObject({ _board: { projectId: project.id, sourceId: "a" }, revision: initialHash });
      const native = await sessions.board(dir), first = (await native.getFootprints()).find(part => part.reference === "R1")!;
      const copper = async () => Object.fromEntries(await Promise.all((["tracks", "vias", "zones", "nets"] as const).map(async kind => [kind, await design.query(dir, kind)])));
      const beforeCopper = await copper();
      const result = await run("pcb_place", { placements: [{ reference: "R1", position: { x: first.position.x / 1e6 + .1, y: first.position.y / 1e6 } }], expectedSourceSha256: initialHash, staleCopper: "keep" });
      expect(result.json).toMatchObject({ saved: true, moved: ["R1"], _board: { projectId: project.id, sourceId: "a", manifestSha256: board.manifestSha256 } });
      expect((await native.getFootprints()).find(part => part.id === first.id)!.position).toEqual({ x: first.position.x + 100_000, y: first.position.y });
      expect(await copper()).toEqual(beforeCopper); expect(await readFile(paths[1]!)).toEqual(other);
      const placed = await readFile(paths[0]!), placedHash = sha(placed); expect(placedHash).not.toBe(initialHash);
      await expect(run("pcb_resize_outline", { edgeIds: ["44444444-4444-4444-4444-444444444441"], widthMm: 20, heightMm: 15, expectedSourceSha256: initialHash })).rejects.toThrow("PCB changed"); expect(await readFile(paths[0]!)).toEqual(placed);
      const placedParts = await design.query(dir, "components"), placedPads = await design.query(dir, "pads");
      const resized = await run("pcb_resize_outline", { edgeIds: ["44444444-4444-4444-4444-444444444441"], widthMm: 20, heightMm: 15, expectedSourceSha256: placedHash });
      expect(resized.json).toMatchObject({ saved: true, edgeIds: ["44444444-4444-4444-4444-444444444441"], bounds: { minX: 100, minY: 95, maxX: 120, maxY: 110 }, _board: { sourceId: "a" } });
      expect(await design.query(dir, "components")).toEqual(placedParts); expect(await design.query(dir, "pads")).toEqual(placedPads); expect(await copper()).toEqual(beforeCopper);
      const final = await readFile(paths[0]!); await writeFile(declaration, Buffer.concat([manifest, Buffer.from("\n")]));
      await expect(run("pcb_place", { placements: [{ reference: "R1", rotation: 90 }], expectedSourceSha256: sha(final) })).rejects.toThrow("membership changed");
      expect(await readFile(paths[0]!)).toEqual(final); expect(await readFile(paths[1]!)).toEqual(other);
      expect(await readFile(join(root, "board.kicad_pcb"), "utf8")).toBe("Unrelated project root must remain unchanged");
      await writeFile(declaration, manifest);
      const unsupported = contextFactory(services, project);
      await expect(registry.invoke("pcb_place", { board, placements: [{ reference: "R1", rotation: 90 }], expectedSourceSha256: sha(final) }, (projectRef, def) => unsupported({ projectRef, def, signal: new AbortController().signal, progress: () => {} }))).rejects.toThrow("did not establish");
      expect(await readFile(paths[0]!)).toEqual(final);
      await servers.get(dir)!.stop(); servers.delete(dir);
      const reopened = await sessions.board(dir), reopenedPart = (await reopened.getFootprints()).find(part => part.id === first.id)!;
      expect(reopenedPart.position).toEqual({ x: first.position.x + 100_000, y: first.position.y });
      const edge = (await reopened.getShapes()).find(shape => shape.id === "44444444-4444-4444-4444-444444444441")!;
      expect(edge.start).toEqual({ x: 100_000_000, y: 95_000_000 }); expect(edge.end).toEqual({ x: 120_000_000, y: 110_000_000 });
      expect(await readFile(paths[0]!)).toEqual(final); expect(await readFile(paths[1]!)).toEqual(other);
    } finally { await Promise.all([...servers.values()].map(server => server.stop())); await rm(dirname(project.dir), { recursive: true, force: true }); }
  }, 120_000);
});
