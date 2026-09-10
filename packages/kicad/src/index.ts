export {
  findKicadCli,
  runKicadCli,
  countCopperLayers,
  bundledKicadRoots,
  bundledKicadCliCandidates,
  type KicadCli,
  type RunOptions,
  type RunResult,
} from "./cli";
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
export { runDrc, runErc, gate, parseDrcJson, parseErcJson, type DrcViolation, type DrcReport, type ErcReport, type GateResult, type Severity } from "./drc";
export { exportGerbers, exportDrill, exportDxf, exportPos, exportBom, exportNetlist, exportSchematicSvg, exportPcbSvg } from "./exports";
