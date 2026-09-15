/**
 * What the daemon provides to tool handlers. Structural mirrors of the sibling package APIs so
 * `@fabdesk/tools` depends only on `@fabdesk/protocol` and can be exercised with mocks.
 * `apps/core/src/services.ts` implements this with the real packages.
 *
 * The design lives in KiCad: `DesignService` talks to a FabPlane PCB bridge (one `kicad-cli
 * api-server` per project) for building, querying, routing and library search; `KicadService`
 * runs the fork `kicad-cli` for DRC, renders and exports; `SimService` reads the netlist source.
 */
import type { CoreEvent, FpPcbBoardSpec, NetlistFile, Principal, RouteResult, Settings } from "@fabdesk/protocol";
import type { ProjectHandle } from "./registry";

export type BuildError = { message: string; line?: number; column?: number; file?: string; type?: string };

export type BuildOptions = {
  projectDir: string;
  /** Source file relative to the project; default `circuit.netlist.json`. */
  entrypoint?: string;
  /** Replaces the netlist file's `board` for this build (a template's blank, the manifest's rules). */
  board?: FpPcbBoardSpec;
  /** Start from nothing: drop the session's board and the generated board files first, so the outline, placement and routing are redone. */
  fresh?: boolean;
  signal?: AbortSignal;
  /** Stage progress from the compile job; tools map it into their own range. */
  progress?: (fraction: number, note?: string) => void;
};

export type BuildCounts = { components: number; nets: number; footprintsAdded: number; footprintsPlaced: number; viasAdded?: number; holesAdded?: number };

export type BuildResult = {
  ok: boolean;
  errors: BuildError[];
  warnings: BuildError[];
  counts: BuildCounts;
  durationMs: number;
  /** Board revision the bridge reported after the compile. */
  revision?: number;
};

export type DesignSelect = "components" | "nets" | "pads" | "vias" | "tracks" | "unrouted" | "outline";
export type DesignRow = Record<string, unknown>;

export type RouteJobOptions = {
  router: "capacity" | "freerouting";
  /** Only these nets; default every unrouted connection. */
  nets?: string[];
  maxTimeMs?: number;
  refillZones?: boolean;
  settings?: Record<string, unknown>;
};

export type RouteProgress = {
  state: string;
  log: string[];
  phase?: string;
  /** Solver progress within the phase, 0–100, when the router reports one. */
  percent?: number;
  message?: string;
  pass?: number;
  routed?: number;
  total?: number;
};

export type RouteSummary = {
  tracks: number;
  /** Vias the router added. */
  vias: number;
  /** Free vias (a blank's) the routing claimed instead of adding its own. */
  claimedVias: number;
  /** JS router preset: `default` or `laser-prefab`. */
  preset?: string;
  routed: number;
  total: number;
  trackLengthNm: number;
  elapsedMs: number;
  wallMs: number;
  timedOut: boolean;
  message: string;
  unrouted: Array<{ net: string; from: { x: number; y: number }; to: { x: number; y: number } }>;
  log: string[];
};

export type ComponentScope = {
  components: string[];
  missing: string[];
  nets: string[];
  excluded: Array<{ net: string; reason: string }>;
  /** Pads per component reference. */
  pads: Record<string, number>;
};

export type FootprintHit = { libId: string; nickname: string; name: string; description: string };

export type DesignStatus = {
  url: string;
  ok: boolean;
  reason?: string;
  kicadCliExists?: boolean;
  frontends?: string[];
};

export interface DesignService {
  /** Compile the project's netlist into `board.kicad_pcb` through the bridge. */
  build(opts: BuildOptions): Promise<BuildResult>;
  /** Rows describing the board as KiCad holds it. */
  query(projectDir: string, select: DesignSelect, filter?: string): Promise<DesignRow[]>;
  /** Autoroute on the bridge; resolves when the job ends. */
  route(projectDir: string, opts: RouteJobOptions, hooks: { onProgress?: (p: RouteProgress) => void; signal?: AbortSignal }): Promise<RouteSummary>;
  /** Cancel the running route job of a project (or every running one). */
  cancelRoute(projectDir?: string): Promise<void>;
  /** Delete tracks, arcs and vias — of the given nets, or all of them. */
  unroute(projectDir: string, nets?: string[]): Promise<{ tracks: number; vias: number }>;
  /** Nets attached to component references (repair scope). */
  scope(projectDir: string, refs: string[], opts?: { excludePlaneNets?: boolean; excludeNets?: string[] }): Promise<ComponentScope>;
  /** Footprints in the KiCad libraries the bridge's server can see. */
  searchFootprints(query: string, limit: number): Promise<FootprintHit[]>;
  /** Move footprints (mm, degrees) on the built board; returns what moved and the references it could not find. */
  place(projectDir: string, placements: Array<{ ref: string; x: number; y: number; rotation?: number }>): Promise<{ moved: Array<{ ref: string; x: number; y: number; rotation: number }>; missing: string[] }>;
  status(): Promise<DesignStatus>;
  /** Drop the project's session (project closed or deleted). */
  release(projectDir: string): Promise<void>;
}

/** Resolved kicad-cli binary (mirrors @fabdesk/kicad KicadCli). */
export type KicadRunResult = { stdout: string; stderr: string; exitCode: number };
export type KicadCli = {
  path: string;
  version: string;
  trace?: (input: { command: string[]; cwd: string }, invoke: () => Promise<KicadRunResult>) => Promise<KicadRunResult>;
};
export type BoardView = "top" | "bottom" | "perspective" | "side";

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
  /** settings → KICAD_CLI env → bundled FabPlane KiCad → PATH / known locations; null when none work. */
  resolveCli(): Promise<KicadCli | null>;
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
  /** One DXF per layer (mm), the copper-removal artwork for laser/CNC-finished blanks. */
  exportDxf(cli: KicadCli, opts: { board: string; outDir: string; layers: string[]; signal?: AbortSignal }): Promise<{ paths: string[] }>;
  exportPos(cli: KicadCli, opts: { board: string; output: string; signal?: AbortSignal }): Promise<{ paths: string[] }>;
  exportBom(cli: KicadCli, opts: { schematic: string; output: string; signal?: AbortSignal }): Promise<{ paths: string[] }>;
  exportNetlist(cli: KicadCli, opts: { schematic: string; output: string; format: "kicadsexpr" | "spice"; signal?: AbortSignal }): Promise<{ paths: string[] }>;
  exportSchematicSvg(cli: KicadCli, opts: { schematic: string; outDir: string; signal?: AbortSignal }): Promise<{ paths: string[] }>;
  exportPcbSvg(cli: KicadCli, opts: { board: string; output: string; layers?: string[]; signal?: AbortSignal }): Promise<{ paths: string[] }>;
}

export type SimAnalysis = { type: "op" } | { type: "tran"; stopS: number; stepS?: number } | { type: "ac"; startHz: number; stopHz: number; points?: number };
export type SimResult = { engine: string; analysis: string; columns: string[]; rows: number[][]; notes?: string[]; durationMs: number };

export interface SimService {
  spiceNetlist(netlist: NetlistFile): string;
  runSimulation(opts: { netlist: NetlistFile; analysis: SimAnalysis; engine?: "spicey" | "ngspice"; ngspicePath?: string; signal?: AbortSignal }): Promise<SimResult>;
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

export type AppBridgeStatus = {
  running: boolean;
  url?: string;
  pid?: number;
  /** Why the bridge is not usable (no handshake file, process gone, wrong token, ...). */
  reason?: string;
};

/**
 * Loopback HTTP bridge into the running fabPlane desktop app (Electron main, dev/automation builds
 * only; see docs/app-automation.md). `apps/core/src/app-bridge.ts` implements it.
 */
export interface AppBridge {
  status(): Promise<AppBridgeStatus>;
  /** JSON request to the bridge; throws `ToolError("unavailable")` when the app is not reachable. */
  call<T = unknown>(method: "GET" | "POST", path: string, body?: unknown, opts?: { timeoutMs?: number }): Promise<T>;
}

export interface CoreServices {
  version: string;
  channel: "public" | "internal";
  settings(): Settings;
  projects: ProjectResolver;
  bus: EventBusLike;
  routeRuns: RouteRunStore;
  design: DesignService;
  kicad: KicadService;
  sim: SimService;
  principal(): Principal | null;
  /** Optional: override fetch (tests, offline). */
  fetch?: typeof fetch;
  /** Optional: the desktop app automation bridge (`app` toolset). Absent in headless/standalone setups. */
  appBridge?: AppBridge;
}
