/** In-memory CoreServices + ProjectHandle for tests (no KiCad, no router worker). */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoreEvent, ProjectManifest, RouteResult } from "@fabdesk/protocol";
import { makeContext, type ContextFactory, type CoreServices, type ProjectHandle, type RouteRunRecord, type ToolRegistry, type ToolsetId } from "../src";
import { TOOLSETS } from "../src/registry";

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
  await writeFile(join(dir, "circuit.tsx"), "export default () => <board width=\"20mm\" height=\"20mm\" />\n");
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

export function mockServices(projects: ProjectHandle[], overrides: Partial<CoreServices> = {}): CoreServices & { events: CoreEvent[] } {
  const events: CoreEvent[] = [];
  const runs = new Map<string, RouteRunRecord>();
  const svc: CoreServices & { events: CoreEvent[] } = {
    events,
    version: "0.0.0-test",
    channel: "public",
    settings: () => ({
      kicadCliPath: null,
      ngspicePath: null,
      router: "capacity",
      defaultAgent: "claude",
      agents: {},
      keepCoreRunning: false,
      webmcpWriteTools: false,
      theme: "system",
    }),
    projects: {
      resolve: async (ref) => projects.find((p) => p.id === ref || p.name === ref || p.dir === ref) ?? null,
      list: async () => projects,
    },
    bus: { emit: (e) => events.push(e) },
    routeRuns: {
      start: (r) => runs.set(r.id, { ...r, status: "running", endedAt: null, result: null, error: null }),
      finish: (id, patch) => {
        const r = runs.get(id);
        if (r) runs.set(id, { ...r, ...patch, endedAt: new Date().toISOString() });
      },
      get: (id) => runs.get(id) ?? null,
      latest: (pid) => [...runs.values()].filter((r) => r.projectId === pid).at(-1) ?? null,
    },
    tscircuit: {
      buildCircuit: async ({ projectDir }) => {
        const src = await Bun.file(join(projectDir, "circuit.tsx")).text();
        const bad = src.includes("BROKEN");
        return {
          ok: !bad,
          circuitJson: bad ? [] : [{ type: "source_component", name: "R1" }, { type: "pcb_board", width: 20, height: 20 }],
          errors: bad ? [{ message: "BROKEN marker found", line: 1, column: 1 }] : [],
          warnings: [],
          elementCounts: bad ? {} : { source_component: 1, pcb_board: 1 },
          durationMs: 5,
        };
      },
      runChecks: async () => ({ errors: [] }),
      queryCircuit: (cj, select) => (cj as Array<Record<string, unknown>>).filter((e) => (select === "errors" ? String(e["type"]).endsWith("_error") : select === "components" ? e["type"] === "source_component" : false)),
      extractSimpleRouteJson: () => ({
        srj: { layerCount: 2, layerNames: ["top", "bottom"], minTraceWidth: 0.15, bounds: { minX: 0, maxX: 20, minY: 0, maxY: 20 }, obstacles: [], connections: [{ name: "N1", pointsToConnect: [{ x: 0, y: 0, layer: "top" }, { x: 5, y: 5, layer: "top" }] }] },
        connectionMap: { N1: "source_trace_0" },
        copper: { traces: 0, vias: 0, pours: 0, obstacles: 0, unowned: 0 },
        extractMs: 1,
      }),
      connectionsForComponents: (_cj, refs) => ({ components: refs, missing: [], connections: ["N1"], nets: ["N1"], excluded: [], ports: {} }),
      mergeTraces: (cj, traces) => [...cj, ...traces],
      unrouteCircuit: (cj) => (cj as Array<Record<string, unknown>>).filter((e) => e["type"] !== "pcb_trace"),
      schematicSvg: () => "<svg xmlns='http://www.w3.org/2000/svg'><text>sch</text></svg>",
      pcbSvg: () => "<svg xmlns='http://www.w3.org/2000/svg'><text>pcb</text></svg>",
    },
    kicad: {
      resolveCli: async () => null,
      convertToKicad: async () => ({ files: [], warnings: [] }),
      importPcb: async ({ pcbPath }) => ({
        circuitJson: [{ type: "pcb_board", width: 15, height: 15, num_layers: 2 }, { type: "source_component", name: "R1" }],
        report: {
          schema: 1,
          importedAt: new Date().toISOString(),
          source: { path: pcbPath, file: "mock.kicad_pcb", sha256: "0".repeat(64), bytes: 1, kicadVersion: 20241229, netEncoding: "net-table", footprintPlacement: "at" },
          board: { widthMm: 15, heightMm: 15, outlinePoints: 4 },
          layers: { copperCount: 4, circuitJsonLayerCount: 4, mapping: [{ kicad: "F.Cu", circuitJson: "top", index: 0, type: "signal" }, { kicad: "In1.Cu", circuitJson: "inner1", index: 1, type: "signal" }, { kicad: "In2.Cu", circuitJson: "inner2", index: 2, type: "signal" }, { kicad: "B.Cu", circuitJson: "bottom", index: 3, type: "signal" }] },
          counts: { footprints: 1, pads: 2, segments: 0, vias: 0, zones: 0, filledPolygons: 0, nets: 1, netsRoutable: 1 },
          elements: { pcb_board: 1 },
          copper: { tracesLinked: 0, tracesUnlinked: 0, viasLinked: 0, viasUnlinked: 0, poursLinked: 0, poursUnlinked: 0 },
          dropped: [],
          unsupported: [],
          designRules: { traceWidthMm: 0.2, clearanceMm: 0.15, viaDiameterMm: 0.6, viaDrillMm: 0.3 },
          timings: { readMs: 1, parseMs: 1, convertMs: 1, linkMs: 1, totalMs: 4 },
          warnings: [],
          failures: [],
        },
      }),
      runDrc: async () => ({ violations: [], unconnected: [], schematicParity: [], counts: { errors: 0, warnings: 0, unconnected: 0 } }),
      runErc: async () => ({ violations: [], counts: { errors: 0, warnings: 0 } }),
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
      exportGlb: async () => ({ fused: false, warnings: [] }),
      boardStats: async () => ({}),
      exportGerbers: async () => ({ paths: [] }),
      exportDrill: async () => ({ paths: [] }),
      exportDxf: async () => ({ paths: [] }),
      exportPos: async () => ({ paths: [] }),
      exportBom: async () => ({ paths: [] }),
      exportNetlist: async () => ({ paths: [] }),
      exportSchematicSvg: async () => ({ paths: [] }),
    },
    router: {
      route: async (req, { onMessage, signal }) => {
        onMessage({ kind: "meta", runId: req.runId, router: req.router, bounds: { x1: 0, y1: 0, x2: 20, y2: 20 }, layers: ["top", "bottom"], unitsPerMm: 1 });
        onMessage({ kind: "static", runId: req.runId, shapes: [] });
        for (let i = 0; i < 3; i++) {
          if (signal?.aborted) throw new Error("aborted");
          await new Promise((r) => setTimeout(r, 5));
          onMessage({ kind: "frame", runId: req.runId, seq: i, event: { kind: i === 2 ? "connection" : "attempt", netNumber: 1 }, elapsedMs: i * 5, shapes: [{ k: "trace", id: i, layer: 0, net: 1, pts: [0, 0, i, i], w: 0.15 }] });
        }
        const result: RouteResult = {
          runId: req.runId,
          router: req.router,
          traces: [{ type: "pcb_trace", pcb_trace_id: "t1", connection_name: "N1", route: [{ route_type: "wire", x: 0, y: 0, width: 0.15, layer: "top" }, { route_type: "wire", x: 5, y: 5, width: 0.15, layer: "top" }] }],
          complete: ["N1"],
          open: [],
          timedOut: false,
          stats: { vias: 0, segments: 1, wallMs: 15, frames: 3 },
        };
        return result;
      },
      cancel: () => {},
      available: async () => [{ id: "capacity", present: true, ready: true, detail: "mock" }],
    },
    sim: {
      spiceNetlist: () => "* mock\nR1 1 0 1k\n.end\n",
      runSimulation: async () => ({ engine: "spicey", analysis: "op", columns: ["node", "V"], rows: [[1, 3.3]], durationMs: 1 }),
      findNgspice: async () => null,
    },
    principal: () => null,
    ...overrides,
  };
  return svc;
}

export function contextFactory(services: CoreServices, defaultProject: ProjectHandle | null = null): ContextFactory {
  return async (req) => {
    const project = req.projectRef ? await services.projects.resolve(req.projectRef) : defaultProject;
    return makeContext({ services, project, signal: req.signal, progress: req.progress, ...(req.session ? { session: req.session } : {}) });
  };
}

export function allToolsets(): ToolsetId[] {
  return [...TOOLSETS];
}

export type { ToolRegistry };
