/**
 * What the daemon provides to tool handlers. Structural mirrors of the sibling package APIs so
 * `@fabdesk/tools` depends only on `@fabdesk/protocol` and can be exercised with mocks.
 * `apps/core/src/services.ts` implements this with the real packages.
 *
 * The design lives in KiCad: `DesignService` talks to a FabPlane PCB bridge (one `kicad-cli
 * api-server` per project) for building, querying, routing and library search; `KicadService`
 * runs the fork `kicad-cli` for DRC, renders and exports; `SimService` reads the netlist source.
 */
import type {
  CoreEvent,
  FpPcbBoardSpec,
  NetlistFile,
  Principal,
  RouteResult,
  Settings,
} from "@fabdesk/protocol";
import type { ProjectHandle } from "./registry";

export type BuildError = {
  message: string;
  line?: number;
  column?: number;
  file?: string;
  type?: string;
};

export type BuildOptions = {
  projectDir: string;
  /** Source file relative to the project; default `circuit.netlist.json`. */
  entrypoint?: string;
  /** Replaces the netlist file's `board` for this build (a template's blank, the manifest's rules). */
  board?: FpPcbBoardSpec;
  /** Preserve compatible copper (default), or remove routed copper before rebuilding. */
  rebuild?: "preserve" | "clean";
  signal?: AbortSignal;
  /** Stage progress from the compile job; tools map it into their own range. */
  progress?: (fraction: number, note?: string) => void;
};

export type BuildCounts = {
  components: number;
  nets: number;
  footprintsAdded: number;
  footprintsPlaced: number;
  viasAdded?: number;
  holesAdded?: number;
};

export type BuildResult = {
  ok: boolean;
  errors: BuildError[];
  warnings: BuildError[];
  counts: BuildCounts;
  durationMs: number;
  /** Board revision the bridge reported after the compile. */
  revision?: number;
  /** Copper removed by a clean rebuild. */
  removedCopper?: { tracks: number; vias: number };
  /** Rejected candidate retained for diagnosis after a fail-closed schematic build. */
  rejectedSchematicPath?: string;
};

export type DesignSelect =
  | "components"
  | "nets"
  | "pads"
  | "vias"
  | "tracks"
  | "zones"
  | "keepouts"
  | "board_geometry"
  | "texts"
  | "unrouted";
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
  /** Copper added or claimed by this run, converted to millimetres. */
  geometry?: Array<{
    kind: "trace" | "via";
    id: string;
    layer: number;
    net: number;
    points: number[];
    width?: number;
  }>;
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

export type DataAvailability = "available" | "missing" | "unsupported";
export type PartBounds = {
  min: { x: number; y: number };
  max: { x: number; y: number };
  size: { x: number; y: number };
};
export type PartRoleSuitability = {
  role: "power-only-usb-c";
  suitable: boolean;
  reasons: string[];
};
export type PartDescription = {
  kind: "footprint" | "symbol";
  libId: string;
  description: string;
  keywords?: string[];
  datasheet?: string;
  roleSuitability?: PartRoleSuitability[];
  anchor?: { x: number; y: number };
  pins?: Array<{
    number: string;
    name: string;
    electricalType: string;
    position: { x: number; y: number };
  }>;
  pads?: Array<{
    number: string;
    type?: string;
    shape?: string;
    layers?: string[];
    position: { x: number; y: number };
    size: { x: number; y: number };
  }>;
  package?: {
    assemblyMethod: "smd" | "through-hole" | "mixed" | "unspecified";
    bodyBounds?: PartBounds;
    courtyardBounds?: PartBounds;
    connectorEdgeDatum?: { axis: "x" | "y"; coordinate: number; label: string };
  };
  fabrication?: {
    courtyard: DataAvailability;
    fabOutline: DataAvailability;
    threeDModels: DataAvailability;
    models: string[];
    includedInBom: boolean | "unsupported";
    includedInPositionFiles: boolean | "unsupported";
  };
};
export type FootprintHit = {
  libId: string;
  nickname: string;
  name: string;
  description: string;
  part?: PartDescription;
};
export type PartCompatibility = {
  symbolLibId: string;
  footprintLibId: string;
  symbol: PartDescription;
  footprint: PartDescription;
  compatible: boolean;
  pinPad: {
    compatible: boolean;
    matched: string[];
    missingPadsForPins: string[];
    padsWithoutPins: string[];
  };
  role?: PartRoleSuitability;
  issues: string[];
  warnings: string[];
};

export type DesignStatus = {
  url: string;
  ok: boolean;
  reason?: string;
  kicadCliExists?: boolean;
  frontends?: string[];
  routers?: {
    capacity?: { ok: boolean; reason?: string };
    freerouting?: { ok: boolean; reason?: string };
  };
};

export type SchematicPoint = { x: number; y: number };
export type NativeSchematicSymbolInput = {
  libId: string;
  reference: string;
  value: string;
  /** Omit for non-physical symbols such as power flags. */
  footprint?: string | undefined;
  position: SchematicPoint;
  unit?: number | undefined;
  bodyStyle?: number | undefined;
  rotation?: 0 | 90 | 180 | 270 | undefined;
  mirrorX?: boolean | undefined;
  mirrorY?: boolean | undefined;
  fields?: Record<string, string> | undefined;
};
export type NativeSchematicSymbolUpdate = {
  reference: string;
  newReference?: string | undefined;
  position?: SchematicPoint | undefined;
  value?: string | undefined;
  footprint?: string | undefined;
  fields?: Record<string, string> | undefined;
};
export type NativeSchematicConnectionInput = {
  name: string;
  nodes: Array<{ reference: string; pin: string }>;
  label?: "local" | "global" | "none" | undefined;
};
export type NativeSchematicEdit = {
  symbols?: NativeSchematicSymbolInput[];
  symbolUpdates?: NativeSchematicSymbolUpdate[];
  connections?: NativeSchematicConnectionInput[];
  wires?: Array<{ start: SchematicPoint; end: SchematicPoint }>;
  localLabels?: Array<{ text: string; position: SchematicPoint }>;
  globalLabels?: Array<{ text: string; position: SchematicPoint }>;
  junctions?: SchematicPoint[];
  noConnects?: SchematicPoint[];
  texts?: Array<{ text: string; position: SchematicPoint }>;
  deleteItemIds?: string[];
  save?: boolean;
};
export type NativeSchematicSnapshot = {
  revision: number;
  pcbRevision: number;
  symbols: Array<{
    id: string;
    reference: string;
    value: string;
    footprint: string;
    libId: string;
    position: SchematicPoint;
    rotation: number;
    mirrorX: boolean;
    mirrorY: boolean;
    pins: Array<{ id: string; number: string; name: string; net?: string; position: SchematicPoint }>;
  }>;
  wires: Array<{ id: string; start: SchematicPoint; end: SchematicPoint }>;
  localLabels: Array<{ id: string; text: string; position: SchematicPoint }>;
  globalLabels: Array<{ id: string; text: string; position: SchematicPoint }>;
  junctions: Array<{ id: string; position: SchematicPoint }>;
  noConnects: Array<{ id: string; position: SchematicPoint }>;
  texts: Array<{ id: string; text: string; position: SchematicPoint }>;
  nets: Array<{ name: string; itemCount: number; itemIds: string[] }>;
  erc: { errors: number; warnings: number };
};
export type NativeSchematicEditResult = {
  created: { symbols: number; wires: number; localLabels: number; globalLabels: number; junctions: number; noConnects: number; texts: number };
  updated: { symbols: number };
  deleted: number;
  saved: boolean;
  revision: number;
};
export type SchematicPcbSyncResult = {
  ok: boolean;
  dryRun: boolean;
  erc: { errors: number; warnings: number };
  update: { errors: number; warnings: number; newFootprints: number; report: string };
  parity?: number;
  saved: boolean;
};
export type PcbPlacementResult = {
  moved: string[];
  missing: string[];
  libraryNormalized?: number;
  revision: number;
  saved: boolean;
};
export type PcbFootprintEdit = {
  reference: string;
  position?: SchematicPoint | undefined;
  rotation?: number | undefined;
  flip?: boolean | undefined;
  lock?: boolean | undefined;
  referenceField?: {
    visible?: boolean | undefined;
    position?: SchematicPoint | undefined;
    sizeMm?: number | undefined;
  } | undefined;
};
export type PcbOutlineResult = {
  created: number;
  replaced: number;
  revision: number;
  saved: boolean;
};

export type PcbGeometryEdit = {
  tracks?: Array<{ start: SchematicPoint; end: SchematicPoint; width: number; layer: number; net?: string }>;
  vias?: Array<{ position: SchematicPoint; diameter: number; drill: number; layers: number[]; net?: string }>;
  zones?: Array<{
    points: SchematicPoint[];
    holes?: SchematicPoint[][];
    layers: number[];
    net?: string;
    name?: string;
    clearance?: number;
    minThickness?: number;
    priority?: number;
  }>;
  keepouts?: Array<{
    points: SchematicPoint[];
    holes?: SchematicPoint[][];
    layers: number[];
    name?: string;
    copper?: boolean;
    vias?: boolean;
    tracks?: boolean;
    pads?: boolean;
    footprints?: boolean;
  }>;
  texts?: Array<{
    text: string;
    position: SchematicPoint;
    layer: number;
    size?: SchematicPoint;
    thickness?: number;
    angle?: number;
    knockout?: boolean;
  }>;
  graphics?: Array<{
    kind: "segment" | "rectangle" | "arc" | "circle" | "polygon";
    layer: number;
    start?: SchematicPoint;
    end?: SchematicPoint;
    mid?: SchematicPoint;
    center?: SchematicPoint;
    radiusPoint?: SchematicPoint;
    points?: SchematicPoint[];
    holes?: SchematicPoint[][];
    strokeWidth?: number;
    filled?: boolean;
  }>;
  deleteItemIds?: string[];
};
export type PcbGeometryEditResult = {
  created: { tracks: number; vias: number; zones: number; keepouts: number; texts: number; graphics: number };
  createdIds: string[];
  deletedIds: string[];
  revision: number;
  saved: boolean;
};
export type PcbGeometrySnapshot = Record<string, unknown> & {
  revisionStart?: number;
  revisionEnd?: number;
  revisionStable: boolean;
  pads: Array<Record<string, unknown>>;
  tracks: Array<Record<string, unknown>>;
  vias: Array<Record<string, unknown>>;
  zones: Array<Record<string, unknown>>;
  texts: Array<Record<string, unknown>>;
  graphics: Array<Record<string, unknown>>;
  nets: Array<Record<string, unknown>>;
  rules: Record<string, unknown>;
};

export interface DesignService {
  /** Compile the project's netlist into `board.kicad_pcb` through the bridge. */
  build(opts: BuildOptions): Promise<BuildResult>;
  /** Inspect the native KiCad schematic; creates the project's KiCad documents when requested by an edit. */
  schematicInspect(projectDir: string): Promise<NativeSchematicSnapshot>;
  /** Apply one reviewable batch of native schematic items as a KiCad undo commit. */
  schematicEdit(projectDir: string, edit: NativeSchematicEdit): Promise<NativeSchematicEditResult>;
  /** ERC-gated native Update PCB from Schematic, with dry-run preview and parity verification. */
  syncSchematicToPcb(projectDir: string, dryRun: boolean): Promise<SchematicPcbSyncResult>;
  /** Define or update the compiler-owned physical board boundary. */
  defineBoardOutline(
    projectDir: string,
    points: SchematicPoint[],
    replace: boolean,
  ): Promise<PcbOutlineResult>;
  /** Place native board footprints by reference without touching schematic connectivity. */
  placeFootprints(
    projectDir: string,
    placements: PcbFootprintEdit[],
  ): Promise<PcbPlacementResult>;
  /** Create and delete explicitly named native board geometry without replacing unrelated items. */
  editBoardGeometry(projectDir: string, edit: PcbGeometryEdit): Promise<PcbGeometryEditResult>;
  /** Canonical board geometry, transformed pads, nets, layers, and applicable clearance data. */
  inspectBoardGeometry(projectDir: string): Promise<PcbGeometrySnapshot>;
  /** Rows describing the board as KiCad holds it. */
  query(projectDir: string, select: DesignSelect, filter?: string): Promise<DesignRow[]>;
  /** Autoroute on the bridge; resolves when the job ends. */
  route(
    projectDir: string,
    opts: RouteJobOptions,
    hooks: { onProgress?: (p: RouteProgress) => void; signal?: AbortSignal },
  ): Promise<RouteSummary>;
  /** Cancel the running route job of a project (or every running one). */
  cancelRoute(projectDir?: string): Promise<void>;
  /** Delete tracks, arcs and vias — of the given nets, or all of them. */
  unroute(projectDir: string, nets?: string[]): Promise<{ tracks: number; vias: number }>;
  /** Nets attached to component references (repair scope). */
  scope(
    projectDir: string,
    refs: string[],
    opts?: { excludePlaneNets?: boolean; excludeNets?: string[] },
  ): Promise<ComponentScope>;
  /** Footprints in the KiCad libraries the bridge's server can see. */
  searchFootprints(query: string, limit: number): Promise<FootprintHit[]>;
  /** Symbols in the KiCad libraries the bridge's server can see. */
  searchSymbols(query: string, limit: number): Promise<FootprintHit[]>;
  /** Pin/pad geometry needed to connect and place one exact library id safely. */
  describePart(kind: "footprint" | "symbol", libId: string): Promise<PartDescription>;
  /** Validate a symbol/footprint pair without placing or changing either one. */
  checkPartCompatibility(
    symbolLibId: string,
    footprintLibId: string,
    role?: "power-only-usb-c",
  ): Promise<PartCompatibility>;
  status(): Promise<DesignStatus>;
  /** Drop the project's session (project closed or deleted). */
  release(projectDir: string): Promise<void>;
}

/** Resolved kicad-cli binary (mirrors @fabdesk/kicad KicadCli). */
export type KicadRunResult = { stdout: string; stderr: string; exitCode: number };
export type KicadCli = {
  path: string;
  version: string;
  trace?: (
    input: { command: string[]; cwd: string },
    invoke: () => Promise<KicadRunResult>,
  ) => Promise<KicadRunResult>;
};
export type BoardView = "top" | "bottom" | "perspective" | "side";

export type DrcViolation = {
  rule: string;
  severity: "error" | "warning" | "exclusion";
  description: string;
  items: Array<{
    description: string;
    uuid?: string;
    pos?: { x: number; y: number };
    net?: string;
    layer?: string | number;
    layers?: Array<string | number>;
  }>;
  coordinates: Array<{ x: number; y: number }>;
  layers: Array<string | number>;
  nets: string[];
  objectIds: string[];
  affectedGeometry: Array<{ objectType: string; [key: string]: unknown }>;
  /** `${rule}:${first item description}`; stable across runs, used for warning baselines. */
  signature: string;
};
export type DrcReport = {
  violations: DrcViolation[];
  unconnected: DrcViolation[];
  schematicParity: DrcViolation[];
  counts: { errors: number; warnings: number; unconnected: number };
  /** True only when this report was produced with PCB-to-schematic parity enabled. */
  schematicParityChecked?: boolean;
  raw?: unknown;
};
export type ErcReport = {
  violations: DrcViolation[];
  counts: { errors: number; warnings: number };
  raw?: unknown;
};
export type GateResult = { pass: boolean; reasons: string[]; newWarningSignatures: string[] };

export interface KicadService {
  /** settings → KICAD_CLI env → known locations; null when KiCad is not installed. */
  resolveCli(): Promise<KicadCli | null>;
  runDrc(
    cli: KicadCli,
    opts: {
      board: string;
      outFile: string;
      severity?: "error" | "all";
      schematicParity?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<DrcReport>;
  runErc(
    cli: KicadCli,
    opts: { schematic: string; outFile: string; severity?: "error" | "all"; signal?: AbortSignal },
  ): Promise<ErcReport>;
  gate(drc: DrcReport, erc: ErcReport | undefined, allowedWarningSignatures: string[]): GateResult;
  renderPng(
    cli: KicadCli,
    opts: {
      board: string;
      output: string;
      view: BoardView;
      width?: number;
      height?: number;
      quality?: "basic" | "high";
      signal?: AbortSignal;
    },
  ): Promise<void>;
  rasterizeSvg(
    svg: string | Uint8Array,
    opts?: { maxWidth?: number; background?: string },
  ): Promise<{ png: Uint8Array; width: number; height: number }>;
  exportGlb(
    cli: KicadCli,
    opts: { board: string; output: string; signal?: AbortSignal },
  ): Promise<{ fused: boolean; warnings: string[] }>;
  boardStats(
    cli: KicadCli,
    opts: { board: string; scratchFile: string },
  ): Promise<Record<string, unknown>>;
  exportGerbers(
    cli: KicadCli,
    opts: { board: string; outDir: string; signal?: AbortSignal },
  ): Promise<{ paths: string[] }>;
  exportDrill(
    cli: KicadCli,
    opts: { board: string; outDir: string; signal?: AbortSignal },
  ): Promise<{ paths: string[] }>;
  /** One DXF per layer (mm), the copper-removal artwork for laser/CNC-finished blanks. */
  exportDxf(
    cli: KicadCli,
    opts: { board: string; outDir: string; layers: string[]; signal?: AbortSignal },
  ): Promise<{ paths: string[] }>;
  exportPos(
    cli: KicadCli,
    opts: { board: string; output: string; signal?: AbortSignal },
  ): Promise<{ paths: string[] }>;
  exportBom(
    cli: KicadCli,
    opts: { schematic: string; output: string; signal?: AbortSignal },
  ): Promise<{ paths: string[] }>;
  exportNetlist(
    cli: KicadCli,
    opts: {
      schematic: string;
      output: string;
      format: "kicadsexpr" | "spice";
      signal?: AbortSignal;
    },
  ): Promise<{ paths: string[] }>;
  exportSchematicSvg(
    cli: KicadCli,
    opts: { schematic: string; outDir: string; signal?: AbortSignal },
  ): Promise<{ paths: string[] }>;
  exportSchematicPdf(
    cli: KicadCli,
    opts: { schematic: string; output: string; signal?: AbortSignal },
  ): Promise<{ paths: string[] }>;
  exportPcbSvg(
    cli: KicadCli,
    opts: { board: string; output: string; layers?: string[]; signal?: AbortSignal },
  ): Promise<{ paths: string[] }>;
}

export type SimAnalysis =
  | { type: "op" }
  | { type: "tran"; stopS: number; stepS?: number }
  | { type: "ac"; startHz: number; stopHz: number; points?: number };
export type SimResult = {
  engine: string;
  analysis: string;
  columns: string[];
  rows: number[][];
  notes?: string[];
  durationMs: number;
};

export interface SimService {
  runSpiceSimulation(opts: {
    netlist: string;
    analysis: SimAnalysis;
    engine?: "spicey" | "ngspice";
    ngspicePath?: string;
    signal?: AbortSignal;
  }): Promise<SimResult>;
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
  call<T = unknown>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<T>;
}

export interface CoreServices {
  version: string;
  /** Attested packaged runtime identity; null only for un-packaged development. */
  runtimeId: string | null;
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
