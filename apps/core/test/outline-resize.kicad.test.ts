import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { BoardLayer } from "@fp-pcb/proto";
import { createFpPcbDesign } from "../src/fp-pcb-design";
import type { FpPcbSessions } from "../src/fp-pcb-session";
import { haveKicad, startKiCad, type RunningKiCad } from "../../../vendor/fab_pcb/packages/client/test/kicad-server";

describe.skipIf(!haveKicad())("native imported rectangle resize", () => {
  test("preserves primitive identity, metadata and routed contents after save and reopen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabplane-imported-outline-")), path = join(dir, "board.kicad_pcb");
    await cp(join(import.meta.dir, "../../../packages/kicad/test/fixtures/mini-two-layer.kicad_pcb"), path);
    let server: RunningKiCad | undefined;
    const openBoard = async () => { if (!server) server = await startKiCad(path, "fabplane-outline-resize"); return (await server.kicad.currentBoard())!; };
    const stop = async () => { await server?.stop(); server = undefined; };
    const design = createFpPcbDesign({ bridge: () => ({}) as never, sessions: { board: openBoard, assertSchematicSaved: async () => {} } as unknown as FpPcbSessions });
    const snapshot = async () => {
      const result: Record<string, unknown> = {};
      for (const kind of ["components", "pads", "tracks", "vias", "zones", "nets"] as const) {
        const rows = await design.query(dir, kind);
        // Reopening this fixture renumbers internal net codes; names and every pad/copper
        // association remain the persistent connectivity identities checked here.
        result[kind] = kind === "nets" ? rows.map(row => { const named = { ...row }; delete named.code; return named; }) : rows;
      }
      return result;
    };
    try {
      const board = await openBoard(), edges = (await board.getShapes()).filter(edge => edge.layerId === BoardLayer.BL_Edge_Cuts);
      expect(edges).toHaveLength(1); expect(edges[0]!.kind).toBe("rectangle");
      const annotated = edges[0]!.clone(); annotated.setCustomProperty("review-note", "Keep this imported outline metadata");
      await board.commit("Fixture: record imported edge metadata", async tx => { await tx.update([annotated]); }); await board.save();
      const original = (await board.getShapes()).find(edge => edge.id === annotated.id)!;
      const originalStyle = original.strokeWidth, originalProperties = original.customProperties;
      expect(originalProperties["review-note"]).toBe("Keep this imported outline metadata");
      const before = await snapshot(), source = await readFile(path);
      const result = await design.resizeBoardOutline(dir, { edgeIds: [original.id], widthMm: 22, heightMm: 16, expectedSourceSha256: createHash("sha256").update(source).digest("hex") });
      expect(result).toMatchObject({ saved: true, changed: true, edgeIds: [original.id], bounds: { minX: 100, minY: 95, maxX: 122, maxY: 111 } });
      await stop();
      const reopened = await openBoard(), afterEdges = (await reopened.getShapes()).filter(edge => edge.layerId === BoardLayer.BL_Edge_Cuts);
      expect(afterEdges).toHaveLength(1); expect(afterEdges[0]!.id).toBe(original.id); expect(afterEdges[0]!.kind).toBe("rectangle");
      expect(afterEdges[0]!.start).toEqual({ x: 100_000_000, y: 95_000_000 }); expect(afterEdges[0]!.end).toEqual({ x: 122_000_000, y: 111_000_000 });
      expect(afterEdges[0]!.strokeWidth).toBe(originalStyle); expect(afterEdges[0]!.customProperties).toEqual(originalProperties);
      expect(await snapshot()).toEqual(before);
    } finally { await stop(); await rm(dir, { recursive: true, force: true }); }
  }, 60_000);
});
