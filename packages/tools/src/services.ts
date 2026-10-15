/**
 * What the daemon provides to tool handlers. Structural mirrors of the sibling package APIs so
 * `@fabdesk/tools` depends only on `@fabdesk/protocol` and can be exercised with mocks.
 * `apps/core/src/services.ts` implements this with the real packages.
 *
 * The design lives in KiCad: `DesignService` talks to a FabPlane PCB bridge (one `kicad-cli
 * api-server` per project) for building, querying, routing and library search; `KicadService`
 * runs the fork `kicad-cli` for DRC, renders and exports; `SimService` reads the netlist source.
 */
import type { CloudService } from "./cloud/service";
import type { RouterRegistry } from "./routers/registry";
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
  /** Start from nothing: drop the session's board and the generated board files first, so the outline, placement and routing are redone. */
  fresh?: boolean;
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
  /** Copper layer count of the board as built (KiCad's enabled layers), when it could be read. */
  copperLayers?: number;
  /** Copper removed by a clean rebuild. */
  removedCopper?: { tracks: number; vias: number };
  /** Rejected candidate retained for diagnosis after a fail-closed schematic build. */
  rejectedSchematicPath?: string;
};

/** Whether copper pours were refilled after a copper change, and why not when they were not. */
export type ZoneRefill = { refilled: boolean; error?: string };

export type DesignSelect =
  | "components"
  | "nets"
  | "pads"
  | "vias"
  | "tracks"
  | "zones"
  | "keepouts"
  | "board_geometry"
  | "footprint_geometry"
  | "texts"
  | "unrouted"
  | "outline";
export type DesignRow = Record<string, unknown>;

export type RouteJobOptions = {
  router: "fab_router" | "freerouting";
  freerouting?: { passes: number };
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
  violations?: number;
};

export type RouteSummary = {
  endpointCollisions?: import("@fabdesk/protocol").EndpointCollisions;
  diagnostics?: import("@fabdesk/protocol").RoutingDiagnostics;
  pairRouting?: import("@fabdesk/protocol").PairRouting;
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
    netName?: string;
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
    fab_router?: { ok: boolean; reason?: string };
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
  rotation?: 0 | 90 | 180 | 270 | undefined;
  mirrorX?: boolean | undefined;
  mirrorY?: boolean | undefined;
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
  sheet?: string | undefined;
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
    pins: Array<{
      id: string;
      number: string;
      name: string;
      net?: string;
      position: SchematicPoint;
    }>;
  }>;
  wires: Array<{ id: string; start: SchematicPoint; end: SchematicPoint }>;
  localLabels: Array<{ id: string; text: string; position: SchematicPoint }>;
  globalLabels: Array<{ id: string; text: string; position: SchematicPoint }>;
  junctions: Array<{ id: string; position: SchematicPoint }>;
  noConnects: Array<{ id: string; position: SchematicPoint }>;
  texts: Array<{ id: string; text: string; position: SchematicPoint }>;
  nets: Array<{ name: string; itemCount: number; itemIds: string[] }>;
  erc: { errors: number; warnings: number };
  /** Live KiCad IPC authoring scope. This is never saved-file ERC evidence. */
  scope?: {
    kind: "current/root-sheet" | "selected-sheet";
    identity?: string;
    hierarchyPath: string;
    nativePath: string | null;
    name: string;
  };
};

export type SchematicHierarchyIssue = {
  kind: "missing" | "unreadable" | "duplicate" | "cycle" | "parse" | "export";
  path: string;
  detail: string;
};
export type SchematicHierarchySheet = {
  hierarchyPath: string;
  nativePath: string;
  identity: string;
  name: string;
  depth: number;
  sha256: string;
  bytes: number;
  components: number;
  nets: number;
};
export type SchematicHierarchy = {
  rootFile: string;
  projectFile: string | null;
  aggregateRevision: string;
  complete: boolean;
  counts: { components: number; nets: number; sheets: number };
  sheets: SchematicHierarchySheet[];
  referencedFiles: string[];
  orphanFiles: string[];
  issues: SchematicHierarchyIssue[];
  source: {
    hierarchy: "native-kicad-project";
    electrical: "packaged-kicad-cli-netlist";
    kicadCli: { path: string; version: string };
  };
};
export type NativeSchematicEditResult = {
  normalizedAwayObjectIds?: string[];
  changedObjectIds?: { created: string[]; updated: string[]; deleted: string[] };
  gridProblems?: Array<{ object: string; position: SchematicPoint; gridSpacing: number }>;

  created: {
    symbols: number;
    wires: number;
    localLabels: number;
    globalLabels: number;
    junctions: number;
    noConnects: number;
    texts: number;
  };
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
  /** Routed copper made stale or shorted by each transformed footprint. */
  staleCopper?: Record<string, PcbStaleCopperReport>;
  /** Stale attached fan-out deleted in the placement transaction. */
  removedCopper?: { ids: string[]; nets: string[] };
  /** Best-effort refill outcome after stale copper was removed. */
  zoneRefill?: { refilled: boolean; error?: string };
  libraryNormalized?: number;
  revision: number;
  saved: boolean;
};
export type PcbStaleCopperItem = {
  id: string;
  kind: "track" | "arc" | "via";
  net: string;
  layer?: string;
  pad: string;
  locked: boolean;
};
export type PcbShortedCopperItem = PcbStaleCopperItem & { padNet: string };
export type PcbStaleCopperReport = {
  stale: PcbStaleCopperItem[];
  shorted: PcbShortedCopperItem[];
  staleCount: number;
  shortedCount: number;
  nets: string[];
};
export type PcbFootprintEdit = {
  reference: string;
  position?: SchematicPoint | undefined;
  rotation?: number | undefined;
  flip?: boolean | undefined;
  lock?: boolean | undefined;
  referenceField?:
    | {
        visible?: boolean | undefined;
        position?: SchematicPoint | undefined;
        sizeMm?: number | undefined;
      }
    | undefined;
};
export type PcbOutlineResult = {
  created: number;
  replaced: number;
  revision: number;
  saved: boolean;
};

export type PcbGeometryEdit = {
  tracks?: Array<{
    start: SchematicPoint;
    end: SchematicPoint;
    width: number;
    layer: number;
    net?: string;
  }>;
  vias?: Array<{
    position: SchematicPoint;
    diameter: number;
    drill: number;
    layers: number[];
    net?: string;
  }>;
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
  created: {
    tracks: number;
    vias: number;
    zones: number;
    keepouts: number;
    texts: number;
    graphics: number;
  };
  createdIds: string[];
  deletedIds: string[];
  revision: number;
  saved: boolean;
  /** Pours are refilled before the save, so the saved board's zones match its copper. */
  zoneRefill?: ZoneRefill;
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
  /** Refuse unsaved live state and suspend session access while captured saved files are restored. */
  withSavedFilesRecovery?<T>(projectDir: string, replace: () => Promise<T>): Promise<T>;
  /** Compile the project's netlist into `board.kicad_pcb` through the bridge. */
  build(opts: BuildOptions): Promise<BuildResult>;
  /** Inspect the native KiCad schematic; creates the project's KiCad documents when requested by an edit. */
  schematicInspect(projectDir: string, sheet?: string): Promise<NativeSchematicSnapshot>;
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
    options?: { staleCopper?: "keep" | "remove" },
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
  unroute(
    projectDir: string,
    nets?: string[],
  ): Promise<{ tracks: number; vias: number; zoneRefill?: ZoneRefill }>;
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
  /** Move footprints (mm, degrees) on the built board; returns what moved and the references it could not find. */
  place(
    projectDir: string,
    placements: Array<{ ref: string; x: number; y: number; rotation?: number }>,
  ): Promise<{
    moved: Array<{ ref: string; x: number; y: number; rotation: number }>;
    missing: string[];
  }>;
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

/** Structural mirror of @fabdesk/kicad `MechanicalSection`; the report stores it verbatim. */
export type MechanicalReport = {
  contract: { name: string; version: string };
  status: "present" | "partial" | "missing" | "inapplicable" | "not-requested";
  source: {
    pcbRevision: string;
    cache: { status: "hit" | "miss" | "disabled"; key: string | null; reason?: string };
    [key: string]: unknown;
  };
  coverage: Record<string, number>;
  interference: {
    broadPhaseOverlapCandidates: { count: number; truncated: boolean; [key: string]: unknown };
    collision: { status: string; [key: string]: unknown };
    [key: string]: unknown;
  };
  issues: Array<{ code: string; severity: string; [key: string]: unknown }>;
  [key: string]: unknown;
};

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
  /** settings → KICAD_CLI env → bundled FabPlane KiCad → PATH / known locations; null when none work. */
  resolveCli(): Promise<KicadCli | null>;
  runDrc(
    cli: KicadCli,
    opts: {
      board: string;
      outFile: string;
      severity?: "error" | "all";
      schematicParity?: boolean;
      refillZones?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<DrcReport>;
  runErc(
    cli: KicadCli,
    opts: { schematic: string; outFile: string; severity?: "error" | "all"; signal?: AbortSignal },
  ): Promise<ErcReport>;
  /** Shared saved native hierarchy and packaged-KiCad complete-project electrical facts. */
  inspectSchematicHierarchy(
    cli: KicadCli,
    opts: { projectDir: string; rootSchematic: string; projectFile?: string; signal?: AbortSignal },
  ): Promise<SchematicHierarchy>;
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
  /**
   * Per-footprint 3D model coverage and exact board-space bounds measured from the packaged
   * `kicad-cli pcb export glb`; `scratchDir` (temporary GLB only) must be jailed to the project.
   */
  measureMechanical(
    cli: KicadCli,
    opts: { projectDir: string; board: string; scratchDir: string; signal?: AbortSignal },
  ): Promise<MechanicalReport>;
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

export type RouteRunState =
  | "queued"
  | "running"
  | "cancel_requested"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed"
  | "timed_out"
  | "interrupted";

export type RouteApplyState =
  | "pending"
  | "manual"
  | "applying"
  | "applied"
  | "stale"
  | "rejected"
  | "failed"
  | "not_available";

export type RouteRunRecord = {
  id: string;
  projectId: string;
  router: string;
  /** Historical records may predate attempt tracking. router identifies the final producer. */
  attempts?: Array<{
    router: "fab_router" | "freerouting" | "tracemaker";
    startedAt: string;
    endedAt: string | null;
    outcome: "running" | "completed" | "failed" | "unavailable" | "skipped" | "cancelled" | "timed_out";
    reason: string | null;
  }>;
  fallbackReason?: string | null;
  runtimeId: string | null;
  state: RouteRunState;
  /** Compatibility alias for older HTTP/mobile consumers. */
  status: RouteRunState;
  framesPath: string;
  artifacts: {
    runDir: string;
    request: string;
    progress: string;
    frames: string;
    log: string;
    result: string;
    candidate: string;
    diff: string;
    drcCheck?: string;
  };
  /** New native errors that blocked this candidate; retained for agent inspection. */
  drcErrors?: DrcViolation[];
  request: {
    timeoutMs: number;
    deadlineAt: string;
    onlyConnections: string[] | null;
    targets: Array<{
      net: string;
      from?: { x: number; y: number } | undefined;
      to?: { x: number; y: number } | undefined;
    }> | null;
    rules: Record<string, unknown> | null;
    settings: Record<string, unknown> | null;
    applyPolicy: "auto" | "manual";
  };
  startingPcbRevision: string;
  currentPcbRevision: string | null;
  canonicalMatchesStart: boolean;
  progress: {
    phase: string;
    pass: number | null;
    routed: number | null;
    total: number | null;
    remaining: number | null;
    violations: number | null;
    elapsedMs: number;
    measuredAt: string;
    heartbeatAt: string;
    diagnostics: string[];
  };
  candidate: {
    available: boolean;
    identity: string | null;
    sha256: string | null;
    bytes: number | null;
    path: string;
    reopenable: boolean;
    inspectedAt: string | null;
    limitation: string | null;
    diff: Record<string, { before: number; after: number; changed: number }> | null;
  };
  application: {
    policy: "auto" | "manual";
    state: RouteApplyState;
    expectedPcbRevision: string;
    resultingPcbRevision: string | null;
    appliedAt: string | null;
    reason: string | null;
  };
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  result: (Omit<RouteResult, "changedGeometry"> & { changedGeometryCount: number }) | null;
  error: string | null;
  terminalReason: string | null;
};

export interface RouteRunStore {
  start(rec: RouteRunRecord): void;
  update(id: string, patch: Partial<RouteRunRecord>): void;
  get(id: string): RouteRunRecord | null;
  latest(projectId: string): RouteRunRecord | null;
}

export interface RouteTaskCoordinator {
  enqueue(
    input: { id: string; projectId: string },
    task: (signal: AbortSignal) => Promise<void>,
  ): "queued" | "running";
  cancel(id: string): "requested" | "already_requested" | "terminal" | "not_found";
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

/**
 * FreeCAD over the FabPlane CAD bridge (`@fab-cad/bridge` on fabPlane/fab_cad): one
 * `FreeCADApiServer` per project, the mechanical model in `model.FCStd`. Values travel in the
 * FreeCAD API's JSON form: numbers, strings with units (`"25 mm"`), and tagged objects
 * (`{"$type": "Placement", …}`), see `src/Api/PROTOCOL.md` in the fabPlane FreeCAD fork.
 */
export type CadObject = {
  name: string;
  label: string;
  type: string;
  status: string;
  isError: boolean;
  visibility: boolean;
  children: string[];
  parents: string[];
  bbox?: { min: [number, number, number]; max: [number, number, number] };
};

export type CadProperty = {
  name: string;
  type: string;
  group: string;
  value: unknown;
  unit?: string;
  expression?: string;
  enum?: string[];
  readOnly: boolean;
};

export type CadModel = {
  /** FreeCAD's internal document name. */
  document: string;
  /** The `.FCStd` on disk. */
  path: string;
  modified: boolean;
  objects: CadObject[];
  undo: string[];
  redo: string[];
};

export type CadExportFormat = "step" | "iges" | "brep" | "stl" | "obj";

export type CadPythonResult = {
  stdout: string;
  stderr: string;
  repr?: string;
  exception?: string;
};

export type CadStatus = {
  bridgeUrl: string;
  reachable: boolean;
  /** Why the bridge is not usable, or what it runs FreeCAD with. */
  detail: string;
  /** The FreeCAD server command the bridge spawns; null when it has none. */
  freecad: string | null;
  /** Whether the bridge serves the fab_cad web UI. */
  ui: boolean;
};

export type CadView = {
  bridgeUrl: string;
  session: string;
  wsUrl: string;
  uiUrl: string | null;
  document: string;
};

export interface CadService {
  status(): Promise<CadStatus>;
  /** The project's model, created (empty) and saved when it does not exist yet. */
  model(projectDir: string): Promise<CadModel>;
  properties(projectDir: string, object: string, names?: string[]): Promise<CadProperty[]>;
  addObject(
    projectDir: string,
    input: {
      type: string;
      name?: string;
      label?: string;
      properties?: Record<string, unknown>;
      group?: string;
    },
  ): Promise<CadObject>;
  setProperties(
    projectDir: string,
    object: string,
    values: Record<string, unknown>,
  ): Promise<CadProperty[]>;
  setExpression(
    projectDir: string,
    object: string,
    path: string,
    expression: string | null,
  ): Promise<void>;
  removeObject(projectDir: string, object: string, recursive?: boolean): Promise<void>;
  recompute(
    projectDir: string,
  ): Promise<{ recomputed: number; errors: Array<{ object: string; message: string }> }>;
  undo(projectDir: string, redo?: boolean): Promise<{ undo: string[]; redo: string[] }>;
  /** Save the model to its `.FCStd`. */
  save(projectDir: string): Promise<{ path: string }>;
  /** Export objects (default every visible top-level shape) as file bytes. */
  export(
    projectDir: string,
    input: { objects?: string[]; format: CadExportFormat },
  ): Promise<{ data: Uint8Array; fileName: string; objects: string[] }>;
  python(
    projectDir: string,
    code: string,
    mode?: "exec" | "eval" | "auto",
  ): Promise<CadPythonResult>;
  /** Where the fab_cad web UI can attach to the project's live session. */
  view(projectDir: string): Promise<CadView>;
  /** Stop the project's FreeCAD session. */
  release(projectDir: string): Promise<void>;
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
  routeTasks: RouteTaskCoordinator;
  design: DesignService;
  kicad: KicadService;
  sim: SimService;
  principal(): Principal | null;
  /** Optional: override fetch (tests, offline). */
  fetch?: typeof fetch;
  /** Optional: the desktop app automation bridge (`app` toolset). Absent in headless/standalone setups. */
  appBridge?: AppBridge;
  /** Optional: fabplane.com carts and inventory (`shopping` toolset, `/cloud` routes). */
  cloud?: CloudService;
  /** Optional: FreeCAD over the FabPlane CAD bridge (`cad` toolset). */
  cad?: CadService;
  /** Install-on-demand autorouter catalog (Settings → Routers). */
  routers?: RouterRegistry;
}
