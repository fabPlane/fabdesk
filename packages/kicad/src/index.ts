export {
  findKicadCli,
  runKicadCli,
  countCopperLayers,
  bundledKicadRoots,
  bundledKicadCliCandidates,
  KicadCliError,
  type KicadCli,
  type KicadInvocation,
  type KicadInvocationTracer,
  type RunOptions,
  type RunResult,
} from "./cli";
export { placeFootprints, type Placement, type PlaceResult } from "./place";
export { rasterizeSvg, type RasterizedSvg } from "./raster";
export {
  renderPng,
  exportGlb,
  boardStats,
  normalizeBoardStatsReport,
  DEFAULT_PERSPECTIVE,
  type BoardView,
  type BoardStats,
  type RenderPngOptions,
  type ExportGlbOptions,
} from "./render";
export {
  runDrc,
  runErc,
  gate,
  parseDrcJson,
  parseErcJson,
  type DrcAffectedGeometry,
  type DrcItem,
  type DrcViolation,
  type DrcReport,
  type ErcReport,
  type GateResult,
  type Severity,
} from "./drc";
export {
  inspectSchematicHierarchy,
  type SchematicHierarchy,
  type SchematicHierarchyIssue,
  type SchematicHierarchySheet,
} from "./hierarchy";
export {
  exportGerbers,
  exportDrill,
  exportDxf,
  exportPos,
  exportBom,
  exportNetlist,
  exportSchematicSvg,
  exportSchematicPdf,
  exportPcbSvg,
} from "./exports";
export {
  MECHANICAL_COLLECTOR,
  MECHANICAL_CACHE_LIMIT,
  MECHANICAL_CONTRACT,
  MECHANICAL_GLB_ARGS,
  MechanicalMemo,
  assembleMechanicalSection,
  collectMechanical,
  exportMechanicalGlb,
  measureGlb,
  mechanicalMemo,
  readSavedBoardModels,
  resolveModelPath,
  type MechanicalSection,
  type MechanicalStatus,
} from "./mechanical";
