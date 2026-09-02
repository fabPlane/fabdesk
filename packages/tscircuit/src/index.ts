export type { BuildError, BuildOptions, BuildResult, CircuitSelect, ExtractedSrj } from "./types";
export { buildCircuit, readCircuitJson, summarizeCircuitJson, collectFsMap } from "./build";
export { runChecks, type CheckError } from "./checks";
export { queryCircuit } from "./query";
export { extractSimpleRouteJson } from "./srj";
export { mergeTraces, unrouteCircuit } from "./merge-traces";
export { schematicSvg, pcbSvg } from "./svg";
export { FileCacheEngine, withRegistryFetchCache } from "./cache";
