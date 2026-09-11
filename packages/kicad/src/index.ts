export { findKicadCli, runKicadCli, countCopperLayers, KicadCliError, type KicadCli, type KicadInvocation, type KicadInvocationTracer, type RunOptions, type RunResult } from "./cli";
export { renderPng, exportGlb, boardStats, normalizeBoardStatsReport, DEFAULT_PERSPECTIVE, type BoardView, type BoardStats, type RenderPngOptions, type ExportGlbOptions } from "./render";
export { rasterizeSvg, type RasterizedSvg } from "./raster";
export { runDrc, runErc, gate, parseDrcJson, parseErcJson, type DrcAffectedGeometry, type DrcItem, type DrcViolation, type DrcReport, type ErcReport, type GateResult, type Severity } from "./drc";
export { exportGerbers, exportDrill, exportDxf, exportPos, exportBom, exportNetlist, exportSchematicSvg, exportSchematicPdf, exportPcbSvg } from "./exports";
