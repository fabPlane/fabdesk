import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectProjectBoardSources } from "@fabdesk/tools";
import { resolveNativeBoardBinding, withNativeBoardBinding } from "../src/assembly-board-binding";
import { createFpPcbDesign } from "../src/fp-pcb-design";
import { FpPcbSessions, type ProjectSession } from "../src/fp-pcb-session";
import { haveKicad, startKiCad, type RunningKiCad } from "../../../vendor/fab_pcb/packages/client/test/kicad-server";

describe.skipIf(!haveKicad())("native assembly ownership", () => {
  test("valid ownership permits a native save; changed membership blocks the next save and preserves live edits", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "fabplane-native-binding-"))), path = join(dir, "board.kicad_pcb"), declaration = join(dir, "fabplane.assembly.json");
    let server: RunningKiCad | undefined;
    try {
      await cp(join(import.meta.dir, "../../../packages/kicad/test/fixtures/mini-two-layer.kicad_pcb"), path);
      await writeFile(declaration, JSON.stringify({ contract: "fabplane.assembly.v1", sources: [{ id: "main", name: "Main", location: "project", directory: "." }], instances: [{ id: "main-1", name: "Main", sourceId: "main" }], connections: [] }));
      const project = { id: "fixture", dir }, inspected = await inspectProjectBoardSources(project);
      const binding = await resolveNativeBoardBinding(project, { sourceId: "main", manifestSha256: inspected.manifestSha256! });
      server = await startKiCad(path, "fabplane-native-binding");
      const kicad = server.kicad, sessions = new FpPcbSessions(() => ({}) as never);
      sessions.session = async () => ({ kicad, path }) as unknown as ProjectSession;
      const board = await sessions.board(dir), source = await readFile(path), original = (await board.getFootprints()).find(part => part.reference === "R1")!;
      const first = original.clone(); first.position = { x: original.position.x + 100_000, y: original.position.y };
      await withNativeBoardBinding(binding, async () => {
        await board.commit("Fixture: owned placement", async tx => { await tx.update([first]); });
        await board.save();
      });
      const saved = await readFile(path); expect(saved).not.toEqual(source);
      expect((await board.getFootprints()).find(part => part.id === original.id)?.position).toEqual(first.position);
      const design = createFpPcbDesign({ bridge: () => ({}) as never, sessions });
      await expect(withNativeBoardBinding(binding, () => design.query(join(dir, "wrong-board"), "components"))).rejects.toThrow("ownership changed");
      const pending = first.clone(); pending.position = { x: first.position.x + 100_000, y: first.position.y };
      await expect(withNativeBoardBinding(binding, async () => {
        await board.commit("Fixture: retain unsaved placement", async tx => { await tx.update([pending]); });
        await writeFile(declaration, "{}");
        await board.save();
      })).rejects.toThrow("ownership changed");
      expect(await readFile(path)).toEqual(saved);
      expect((await board.getFootprints()).find(part => part.id === original.id)?.position).toEqual(pending.position);
      expect(await board.modified()).toBe(true);
    } finally { await server?.stop(); await rm(dir, { recursive: true, force: true }); }
  }, 120_000);
});
