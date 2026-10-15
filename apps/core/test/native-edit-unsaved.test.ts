import { test, expect } from "bun:test";
import { writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createRegistry } from '../../../packages/tools/src/index';
import { contextFactory, mockServices, tempProject } from '../../../packages/tools/test/mock-services';
import { createFpPcbDesign } from '../src/fp-pcb-design';
import { FpPcbSessions } from '../src/fp-pcb-session';

for (const kind of ['pcb', 'schematic']) for (const modified of [true, undefined]) for (const partial of [false, true]) {
 test(`transaction preserves ${kind} modified=${modified} partial=${partial}`, async () => {
  const project = await tempProject(`review-unsaved-${kind}`);
  try {
    const saved = '(kicad_pcb)';
    await writeFile(join(project.dir, 'board.kicad_pcb'), saved);
    if (partial) await writeFile(join(project.dir, 'board.kicad_sch'), '(kicad_sch (version 20250114) (generator eeschema) (uuid 11111111-1111-1111-1111-111111111111) (paper "A4"))');
    let liveUnsaved = true, releases = 0, commits = 0;
    const footprint = { reference: 'D1', locked: false, clone() { return this; } };
    const owner: any = {
      board: async () => ({ getFootprints: async () => [footprint], modified: async () => kind === 'pcb' && liveUnsaved ? modified : false,
        commit: async () => { commits++; } }),
      session: async () => ({ kicad: { currentSchematic: async () => ({ modified: async () => kind === 'schematic' && liveUnsaved ? modified : false }) } }),
      release: async () => { releases++; liveUnsaved = false; },
    };
    owner.assertSchematicSaved = FpPcbSessions.prototype.assertSchematicSaved.bind(owner);
    const design = createFpPcbDesign({ bridge: () => ({}) as any, sessions: owner });
    const services = mockServices([project]);
    services.design.placeFootprints = design.placeFootprints;
    services.design.release = design.release;
    services.design.schematicEdit = async () => { await writeFile(join(project.dir, 'board.kicad_sch'), 'saved earlier operation'); return {} as any; };
    const registry = createRegistry(), factory = contextFactory(services, project);
    let error = '';
    try {
      await registry.invoke('native_edit_transaction', { mode: 'apply', ...(partial ? { schematic: { texts: [{ text: 'earlier', position: { x: 1, y: 1 } }] } } : {}), footprints: [{ reference: 'D1', lock: true }] },
        ref => factory({ def: registry.get('native_edit_transaction')!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }));
    } catch (e) { error = String(e); }
    expect(releases).toBe(0); expect(commits).toBe(0); expect(liveUnsaved).toBe(true);
    expect(await readFile(join(project.dir, 'board.kicad_pcb'), 'utf8')).toBe(saved);
    expect(error).toContain(`save the open ${kind === 'pcb' ? 'PCB' : 'schematic'}`);
    expect(error).toContain(`completed operations: ${partial ? 'schematic' : 'none'}`);
    const backup = /pre-edit backup: ([^;]+)/.exec(error)![1]!;
    expect(JSON.parse(await readFile(join(project.dir, backup), 'utf8')).transactionId).toMatch(/^native-/);
    if (partial) expect(await readFile(join(project.dir, 'board.kicad_sch'), 'utf8')).toBe('saved earlier operation');
  } finally { await rm(dirname(project.dir), { recursive: true, force: true }); }
 });
}
