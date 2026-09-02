/**
 * What the daemon provides to tool handlers. Structural mirrors of the sibling package APIs so
 * `@fabdesk/tools` depends only on `@fabdesk/protocol` and can be exercised with mocks.
 * `apps/core/src/services.ts` implements this with the real packages.
 */
import type {
  CoreEvent,
  Principal,
  RouteRequest,
  RouteResult,
  RouterWorkerMessage,
  Settings,
  SimplifiedPcbTrace,
  SimpleRouteJson,
} from "@fabdesk/protocol";
import type { ProjectHandle } from "./registry";

export type CircuitJson = unknown[];

export type BuildError = { message: string; line?: number; column?: number; file?: string; type?: string };

export type BuildResult = {
  ok: boolean;
  circuitJson: CircuitJson;
  errors: BuildError[];
  warnings: BuildError[];
  elementCounts: Record<string, number>;
  durationMs: number;
};

export type CircuitSelect = "components" | "nets" | "ports" | "traces" | "errors";

/** Resolved kicad-cli binary (mirrors @fabdesk/kicad KicadCli). */
export type KicadCli = { path: string; version: string };
export type BoardView = "top" | "bottom" | "perspective" | "side";

export interface TscircuitService {
  buildCircuit(opts: { projectDir: string; entrypoint?: string; cacheDir?: string; signal?: AbortSignal }): Promise<BuildResult>;
  runChecks(circuitJson: CircuitJson): Promise<{ errors: Array<{ type: string; message: string } & Record<string, unknown>> }>;
  queryCircuit(circuitJson: CircuitJson, select: CircuitSelect, filter?: string): unknown[];
  extractSimpleRouteJson(
    circuitJson: CircuitJson,
    opts?: { minTraceWidth?: number },
  ): { srj: SimpleRouteJson; connectionMap: Record<string, string> };
  mergeTraces(circuitJson: CircuitJson, traces: SimplifiedPcbTrace[], connectionMap: Record<string, string>): CircuitJson;
  unrouteCircuit(circuitJson: CircuitJson, connections?: string[]): CircuitJson;
  schematicSvg(circuitJson: CircuitJson): string;
  pcbSvg(circuitJson: CircuitJson): string;
}

export type DrcViolation = {
  rule: string;
  severity: "error" | "warning" | "exclusion";
  description: string;
  items: Array<{ description: string; uuid?: string; pos?: { x: number; y: number } }>;
  /** `${rule}:${first item description}`; stable across runs, used for warning baselines. */
  signature: string;
};
export type DrcReport = {
  violations: DrcViolation[];
  unconnected: DrcViolation[];
  schematicParity: DrcViolation[];
  counts: { errors: number; warnings: number; unconnected: number };
  raw?: unknown;
};
export type ErcReport = { violations: DrcViolation[]; counts: { errors: number; warnings: number }; raw?: unknown };
export type GateResult = { pass: boolean; reasons: string[]; newWarningSignatures: string[] };

export interface KicadService {
  /** settings → KICAD_CLI env → known locations; null when KiCad is not installed. */
  resolveCli(): Promise<KicadCli | null>;
  convertToKicad(opts: { circuitJson: CircuitJson; projectDir: string; projectName: string }): Promise<{ files: string[]; warnings: string[] }>;
  runDrc(cli: KicadCli, opts: { board: string; outFile: string; severity?: "error" | "all"; schematicParity?: boolean; signal?: AbortSignal }): Promise<DrcReport>;
  runErc(cli: KicadCli, opts: { schematic: string; outFile: string; severity?: "error" | "all"; signal?: AbortSignal }): Promise<ErcReport>;
  gate(drc: DrcReport, erc: ErcReport | undefined, allowedWarningSignatures: string[]): GateResult;
  renderPng(
    cli: KicadCli,
    opts: { board: string; output: string; view: BoardView; width?: number; height?: number; quality?: "basic" | "high"; signal?: AbortSignal },
  ): Promise<void>;
  exportGlb(cli: KicadCli, opts: { board: string; output: string; signal?: AbortSignal }): Promise<{ fused: boolean; warnings: string[] }>;
  boardStats(cli: KicadCli, opts: { board: string; scratchFile: string }): Promise<Record<string, unknown>>;
  exportGerbers(cli: KicadCli, opts: { board: string; outDir: string; signal?: AbortSignal }): Promise<{ paths: string[] }>;
  exportDrill(cli: KicadCli, opts: { board: string; outDir: string; signal?: AbortSignal }): Promise<{ paths: string[] }>;
  exportPos(cli: KicadCli, opts: { board: string; output: string; signal?: AbortSignal }): Promise<{ paths: string[] }>;
  exportBom(cli: KicadCli, opts: { schematic: string; output: string; signal?: AbortSignal }): Promise<{ paths: string[] }>;
  exportNetlist(cli: KicadCli, opts: { schematic: string; output: string; format: "kicadsexpr" | "spice"; signal?: AbortSignal }): Promise<{ paths: string[] }>;
  exportSchematicSvg(cli: KicadCli, opts: { schematic: string; outDir: string; signal?: AbortSignal }): Promise<{ paths: string[] }>;
}

export type RouterProbe = { id: string; present: boolean; ready: boolean; version?: string; detail: string };

export interface RouterService {
  route(request: RouteRequest, opts: { onMessage(m: RouterWorkerMessage): void; signal?: AbortSignal }): Promise<RouteResult>;
  cancel(runId?: string): void;
  available(): Promise<RouterProbe[]>;
}

export type SimAnalysis = { type: "op" } | { type: "tran"; stopS: number; stepS?: number } | { type: "ac"; startHz: number; stopHz: number; points?: number };
export type SimResult = { engine: string; analysis: string; columns: string[]; rows: number[][]; notes?: string[]; durationMs: number };

export interface SimService {
  spiceNetlist(circuitJson: CircuitJson): string;
  runSimulation(opts: { circuitJson: CircuitJson; analysis: SimAnalysis; engine?: "spicey" | "ngspice"; ngspicePath?: string; signal?: AbortSignal }): Promise<SimResult>;
  findNgspice(explicit?: string | null): Promise<string | null>;
}

export type RouteRunRecord = {
  id: string;
  projectId: string;
  router: string;
  status: "running" | "done" | "failed" | "cancelled";
  framesPath: string;
  startedAt: string;
  endedAt: string | null;
  result: RouteResult | null;
  error: string | null;
};

export interface RouteRunStore {
  start(rec: Omit<RouteRunRecord, "endedAt" | "result" | "error" | "status">): void;
  finish(id: string, patch: Pick<RouteRunRecord, "status" | "result" | "error">): void;
  get(id: string): RouteRunRecord | null;
  latest(projectId: string): RouteRunRecord | null;
}

export interface EventBusLike {
  emit(event: CoreEvent): void;
}

export interface ProjectResolver {
  /** id, name, slug or absolute path; null when it does not exist. */
  resolve(ref: string): Promise<ProjectHandle | null>;
  list(): Promise<ProjectHandle[]>;
}

export interface CoreServices {
  version: string;
  channel: "public" | "internal";
  settings(): Settings;
  projects: ProjectResolver;
  bus: EventBusLike;
  routeRuns: RouteRunStore;
  tscircuit: TscircuitService;
  kicad: KicadService;
  router: RouterService;
  sim: SimService;
  principal(): Principal | null;
  /** Optional: override fetch (tests, offline). */
  fetch?: typeof fetch;
}
