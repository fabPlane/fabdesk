export { findKicadCli, runKicadCli, countCopperLayers, type KicadCli, type RunOptions, type RunResult } from "./cli";
export { renderPng, exportGlb, boardStats, DEFAULT_PERSPECTIVE, type BoardView, type BoardStats, type RenderPngOptions, type ExportGlbOptions } from "./render";
export { applyRulesToKicadPro, convertToKicad, type ConvertOptions } from "./convert";
export { runDrc, runErc, gate, parseDrcJson, parseErcJson, type DrcViolation, type DrcReport, type ErcReport, type GateResult, type Severity } from "./drc";
export { exportGerbers, exportDrill, exportPos, exportBom, exportNetlist, exportSchematicSvg } from "./exports";
export { importKicadPcb, KicadImportError, type ImportKicadOptions, type KicadImportReport, type KicadDesignRules, type LayerMapping, type DroppedFeature } from "./import";
export { canonicalNetName, buildNetNameMap, type NetNameMap, type NetNameEntry } from "./net-names";
