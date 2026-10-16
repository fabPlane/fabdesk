/** In-memory CoreServices + ProjectHandle for tests (no KiCad, no router worker). */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoreEvent, NetlistFile, ProjectManifest } from "@fabdesk/protocol";
import {
  makeContext,
  type ContextFactory,
  type CoreServices,
  type ProjectHandle,
  type RouteRunRecord,
  type ToolRegistry,
  type ToolsetId,
} from "../src";
import { TOOLSETS } from "../src/registry";

/** A one-resistor design; a file containing `BROKEN` makes the mock build fail, like the old marker did. */
export const DEMO_NETLIST: NetlistFile = {
  netlist: {
    components: [{ ref: "R1", value: "1k", footprint: "Resistor_SMD:R_0402_1005Metric" }],
    nets: [{ name: "N1", nodes: [{ ref: "R1", pin: "1" }] }],
  },
  board: { widthMm: 20, heightMm: 20 },
};

export async function tempProject(name = "demo"): Promise<ProjectHandle> {
  const root = await mkdtemp(join(tmpdir(), "fabdesk-tools-"));
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  let manifest: ProjectManifest = {
    schema: 1,
    id: `p_${name}`,
    name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    board: { layers: 2 },
    router: "capacity",
    agent: {},
    allowedDrcWarnings: [],
  };
  await writeFile(join(dir, "fabdesk.json"), JSON.stringify(manifest));
  await writeFile(join(dir, "circuit.netlist.json"), JSON.stringify(DEMO_NETLIST, null, 2));
  return {
    id: manifest.id,
    name,
    dir,
    manifest: () => manifest,
    async updateManifest(patch) {
      manifest = { ...manifest, ...patch, updatedAt: new Date().toISOString() };
      await writeFile(join(dir, "fabdesk.json"), JSON.stringify(manifest));
      return manifest;
    },
  };
}

export function mockServices(
  projects: ProjectHandle[],
  overrides: Partial<CoreServices> = {},
): CoreServices & { events: CoreEvent[] } {
  const events: CoreEvent[] = [];
  const runs = new Map<string, RouteRunRecord>();
  const routeControllers = new Map<string, AbortController>();
  const svc: CoreServices & { events: CoreEvent[] } = {
    events,
    version: "0.0.0-test",
    runtimeId: "test-runtime",
    channel: "public",
    settings: () => ({
      kicadCliPath: null,
      ngspicePath: null,
      fpPcbBridgeUrl: null,
      router: "capacity",
      tracemakerManifestUrl: null,
      defaultAgent: "claude",
      agents: {},
      keepCoreRunning: false,
      webmcpWriteTools: false,
      theme: "system",
    }),
    projects: {
      resolve: async (ref) =>
        projects.find((p) => p.id === ref || p.name === ref || p.dir === ref) ?? null,
      list: async () => projects,
    },
    bus: { emit: (e) => events.push(e) },
    routeRuns: {
      start: (r) => runs.set(r.id, r),
      update: (id, patch) => {
        const r = runs.get(id);
        if (r) runs.set(id, { ...r, ...patch });
      },
      get: (id) => runs.get(id) ?? null,
      latest: (pid) => [...runs.values()].filter((r) => r.projectId === pid).at(-1) ?? null,
    },
    routeTasks: {
      enqueue: ({ id }, task) => {
        const controller = new AbortController();
        routeControllers.set(id, controller);
        void Promise.resolve()
          .then(() => task(controller.signal))
          .finally(() => routeControllers.delete(id));
        return "running";
      },
      cancel: (id) => {
        const controller = routeControllers.get(id);
        if (!controller) return "not_found";
        if (controller.signal.aborted) return "already_requested";
        controller.abort();
        return "requested";
      },
    },
    design: {
      withSavedFilesRecovery: async (_dir, replace) => replace(),
      build: async ({ projectDir, progress }) => {
        const src = await Bun.file(join(projectDir, "circuit.netlist.json")).text();
        const bad = src.includes("BROKEN");
        progress?.(0.5, "importing");
        await Bun.write(
          join(projectDir, "board.kicad_pcb"),
          bad ? "" : "(kicad_pcb (version 20260831))\n",
        );
        return {
          ok: !bad,
          errors: bad
            ? [{ message: "BROKEN marker found", line: 1, column: 1, file: "circuit.netlist.json" }]
            : [],
          warnings: [],
          counts: bad
            ? { components: 0, nets: 0, footprintsAdded: 0, footprintsPlaced: 0 }
            : { components: 1, nets: 1, footprintsAdded: 1, footprintsPlaced: 1 },
          durationMs: 5,
          revision: 2,
        };
      },
      schematicInspect: async () => ({
        revision: 0,
        pcbRevision: 0,
        symbols: [],
        wires: [],
        localLabels: [],
        globalLabels: [],
        junctions: [],
        noConnects: [],
        texts: [],
        nets: [],
        erc: { errors: 0, warnings: 0 },
      }),
      schematicEdit: async (_dir, edit) => ({
        created: {
          symbols: edit.symbols?.length ?? 0,
          wires: edit.wires?.length ?? 0,
          localLabels: edit.localLabels?.length ?? 0,
          globalLabels: edit.globalLabels?.length ?? 0,
          junctions: edit.junctions?.length ?? 0,
          noConnects: edit.noConnects?.length ?? 0,
          texts: edit.texts?.length ?? 0,
        },
        updated: { symbols: edit.symbolUpdates?.length ?? 0 },
        deleted: edit.deleteItemIds?.length ?? 0,
        saved: edit.save ?? true,
        revision: 1,
      }),
      syncSchematicToPcb: async (_dir, dryRun) => ({
        ok: true,
        dryRun,
        erc: { errors: 0, warnings: 0 },
        update: { errors: 0, warnings: 0, newFootprints: 0, report: "" },
        ...(dryRun ? {} : { parity: 0 }),
        saved: !dryRun,
      }),
      defineBoardOutline: async (_dir, points, replace) => ({
        created: points.length,
        replaced: replace ? points.length : 0,
        revision: 2,
        saved: true,
      }),
      placeFootprints: async (_dir, placements) => ({
        moved: placements.map((placement) => placement.reference),
        missing: [],
        libraryNormalized: 0,
        revision: 3,
        saved: true,
      }),
      editBoardGeometry: async (_dir, edit) => ({
        created: {
          tracks: edit.tracks?.length ?? 0,
          vias: edit.vias?.length ?? 0,
          zones: edit.zones?.length ?? 0,
          keepouts: edit.keepouts?.length ?? 0,
          texts: edit.texts?.length ?? 0,
          graphics: edit.graphics?.length ?? 0,
        },
        createdIds: [],
        deletedIds: edit.deleteItemIds ?? [],
        revision: 4,
        saved: true,
      }),
      inspectBoardGeometry: async () => ({
        revisionStart: 4,
        revisionEnd: 4,
        revisionStable: true,
        pads: [],
        tracks: [],
        vias: [],
        zones: [],
        texts: [],
        graphics: [],
        nets: [],
        rules: {},
      }),
      query: async (_dir, select, filter) => {
        const rows: Record<string, Array<Record<string, unknown>>> = {
          components: [
            {
              ref: "R1",
              value: "1k",
              footprint: "Resistor_SMD:R_0402_1005Metric",
              x: 1,
              y: 3,
              layer: 0,
            },
          ],
          nets: [{ name: "N1", code: 1, pads: 1 }],
          pads: [
            { component: "R1", number: "1", net: "N1", x: 0.5, y: 3, width: 0.5, height: 0.6 },
          ],
          vias: [],
          tracks: [],
          unrouted: [{ net: "N1", from: "0,0", to: "5,5" }],
        };
        const f = filter?.toLowerCase();
        return (rows[select] ?? []).filter(
          (r) => !f || Object.values(r).some((v) => String(v).toLowerCase().includes(f)),
        );
      },
      route: async (_dir, opts, { onProgress, signal }) => {
        for (let i = 0; i < 3; i++) {
          if (signal?.aborted) throw new Error("aborted");
          await new Promise((r) => setTimeout(r, 5));
          onProgress?.({ state: "routing", log: [], phase: "pass", pass: 1, routed: i, total: 2 });
        }
        return {
          tracks: 1,
          vias: 0,
          claimedVias: 0,
          routed: 2,
          total: 2,
          trackLengthNm: 5_000_000,
          elapsedMs: 10,
          wallMs: 15,
          timedOut: false,
          message: `Autoroute (${opts.router}): 2 connections`,
          unrouted: [],
          log: [],
          geometry: [
            { kind: "trace", id: "track-1", layer: 3, net: 1, points: [0.5, 3, 4, 3], width: 0.25 },
          ],
        };
      },
      cancelRoute: async () => {},
      unroute: async (_dir, nets) => ({ tracks: nets?.length ?? 1, vias: 0 }),
      scope: async (_dir, refs) => ({
        components: refs,
        missing: [],
        nets: ["N1"],
        excluded: [],
        pads: Object.fromEntries(refs.map((r) => [r, 2])),
      }),
      place: async (_dir, placements) => ({
        moved: placements.map((p) => ({ ...p, rotation: p.rotation ?? 0 })),
        missing: [],
      }),
      searchFootprints: async (query, limit) =>
        [
          {
            libId: "Resistor_SMD:R_0402_1005Metric",
            nickname: "Resistor_SMD",
            name: "R_0402_1005Metric",
            description: `matches ${query}`,
          },
        ].slice(0, limit),
      searchSymbols: async (query, limit) =>
        [
          { libId: "Device:R", nickname: "Device", name: "R", description: `matches ${query}` },
        ].slice(0, limit),
      describePart: async (kind, libId) =>
        kind === "symbol"
          ? {
              kind,
              libId,
              description: "Resistor",
              pins: [
                {
                  number: "1",
                  name: "~",
                  electricalType: "PT_PASSIVE",
                  position: { x: -2.54, y: 0 },
                },
              ],
            }
          : {
              kind,
              libId,
              description: "0402 resistor",
              anchor: { x: 0, y: 0 },
              pads: [{ number: "1", position: { x: -0.5, y: 0 }, size: { x: 0.6, y: 0.6 } }],
            },
      status: async () => ({ url: "http://127.0.0.1:4020", ok: true, frontends: ["netlist-json"] }),
      release: async () => {},
    },
    kicad: {
      resolveCli: async () => ({ path: "/mock/kicad-cli", version: "10.99.0" }),
      runDrc: async () => ({
        violations: [],
        unconnected: [],
        schematicParity: [],
        counts: { errors: 0, warnings: 0, unconnected: 0 },
      }),
      runErc: async () => ({ violations: [], counts: { errors: 0, warnings: 0 } }),
      inspectSchematicHierarchy: async (cli) => ({
        rootFile: "board.kicad_sch",
        projectFile: "board.kicad_pro",
        aggregateRevision: "a".repeat(64),
        complete: true,
        counts: { components: 1, nets: 1, sheets: 1 },
        sheets: [
          {
            hierarchyPath: "/",
            nativePath: "board.kicad_sch",
            identity: "mock-root",
            name: "root",
            depth: 0,
            sha256: "b".repeat(64),
            bytes: 1,
            components: 1,
            nets: 1,
          },
        ],
        referencedFiles: ["board.kicad_sch"],
        orphanFiles: [],
        issues: [],
        source: {
          hierarchy: "native-kicad-project",
          electrical: "packaged-kicad-cli-netlist",
          kicadCli: { path: cli.path, version: cli.version },
        },
      }),
      gate: (drc, erc, allowed) => {
        const reasons: string[] = [];
        if (drc.counts.errors) reasons.push(`${drc.counts.errors} DRC errors`);
        if (drc.counts.unconnected) reasons.push(`${drc.counts.unconnected} unconnected`);
        if (erc?.counts.errors) reasons.push(`${erc.counts.errors} ERC errors`);
        const sigs = drc.violations.filter((v) => v.severity === "warning").map((v) => v.signature);
        const newSigs = sigs.filter((s) => !allowed.includes(s));
        if (newSigs.length) reasons.push(`${newSigs.length} new warning signatures`);
        return { pass: reasons.length === 0, reasons, newWarningSignatures: newSigs };
      },
      renderPng: async () => {},
      rasterizeSvg: async (svg, opts) => {
        const { rasterizeSvg } = await import("@fabdesk/kicad");
        return rasterizeSvg(svg, opts);
      },
      exportGlb: async () => ({ fused: false, warnings: [] }),
      measureMechanical: async () => {
        throw new Error("mechanical measurement is not mocked");
      },
      boardStats: async () => ({}),
      exportGerbers: async () => ({ paths: [] }),
      exportDrill: async () => ({ paths: [] }),
      exportDxf: async () => ({ paths: [] }),
      exportPos: async () => ({ paths: [] }),
      exportBom: async () => ({ paths: [] }),
      exportNetlist: async () => ({ paths: [] }),
      exportSchematicSvg: async () => ({ paths: [] }),
      exportSchematicPdf: async () => ({ paths: [] }),
      exportPcbSvg: async (_cli, { output }) => {
        await Bun.write(output, "<svg xmlns='http://www.w3.org/2000/svg'><text>pcb</text></svg>");
        return { paths: [output] };
      },
      exportStencil: async (opts) => {
        const { exportStencil } = await import("@fabdesk/kicad/stencil");
        return exportStencil(opts);
      },
    },
    sim: {
      runSpiceSimulation: async () => ({
        engine: "spicey",
        analysis: "op",
        columns: ["node", "V"],
        rows: [[1, 3.3]],
        durationMs: 1,
      }),
      findNgspice: async () => null,
    },
    principal: () => null,
    ...overrides,
  };
  return svc;
}

export function contextFactory(
  services: CoreServices,
  defaultProject: ProjectHandle | null = null,
): ContextFactory {
  return async (req) => {
    const project = req.projectRef
      ? await services.projects.resolve(req.projectRef)
      : defaultProject;
    return makeContext({
      services,
      project,
      signal: req.signal,
      progress: req.progress,
      ...(req.session ? { session: req.session } : {}),
    });
  };
}

export function allToolsets(): ToolsetId[] {
  return [...TOOLSETS];
}

export type { ToolRegistry };
