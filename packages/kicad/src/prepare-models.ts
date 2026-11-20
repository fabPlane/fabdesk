import { readFile } from "node:fs/promises";
import { withModelCache } from "./model-cache-budget";
import { dirname } from "node:path";
import { componentModelEnvironment, componentModelLibraryRoots, type KicadCli } from "./cli";
import { readSavedBoardModels, resolveModelPath } from "./mechanical";
import { downloadStockModel, officialStockModel, recentlyMissing, stockModelCacheRoot, type ModelFetch } from "./stock-model-cache";

/** Resolve local models first, then fetch only exact missing official STEP models. */
type PreparationOptions = {
  board: string; modelProjectDir?: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv; fetch?: ModelFetch;
  localOnly?: boolean; allowOffline?: boolean;
};
export function prepareBoardModels(cli: KicadCli, options: PreparationOptions) {
  return withModelCache(stockModelCacheRoot(options.env), () => prepare(cli, options));
}
async function prepare(cli: KicadCli, options: PreparationOptions) {
  const env = componentModelEnvironment(options.env ?? process.env, cli.path);
  const projectDir = options.modelProjectDir ?? dirname(options.board), warnings: string[] = [];
  const references = new Map<string, string[]>();
  for (const fp of readSavedBoardModels(await readFile(options.board, "utf8"))) {
    if (fp.dnp) continue;
    // Copper-only test pads have no separate component body to render. Other test
    // points (loops, pins, etc.) still need their own model and must remain visible gaps.
    const boardFeature = /mounting.?hole|fiducial/i.test(fp.footprint) || /^TestPoint:TestPoint_Pad_/i.test(fp.footprint);
    if (!fp.models.length && !boardFeature) warnings.push(`${fp.ref ?? "(unreferenced)"}: no 3D model is assigned; add the exact part model.`);
    for (const model of fp.models) {
      if (model.hidden) continue;
      const refs = references.get(model.declared) ?? []; refs.push(fp.ref ?? "(unreferenced)"); references.set(model.declared, refs);
    }
  }
  const queued: Array<[string, string[]]> = [], roots = componentModelLibraryRoots(env, cli.path);
  let inspected = 0;
  for (const [declared, refs] of references) {
    options.signal?.throwIfAborted();
    const resolved = resolveModelPath(declared, projectDir, env, roots);
    if (resolved.status !== "resolved" && !resolved.substitutionCandidates.length) queued.push([declared, refs]);
    if (++inspected % 32 === 0) await new Promise<void>(resolve => setImmediate(resolve));
  }
  let next = 0, pendingModels = 0;
  const root = stockModelCacheRoot(env);
  let networkUnavailable = false;
  const cancellation = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, cancellation.signal]) : cancellation.signal;
  const workers = Array.from({ length: Math.min(3, queued.length) }, async () => {
    while (next < queued.length) {
      signal.throwIfAborted();
      const [declared, refs] = queued[next++]!;
      if (!officialStockModel(declared)) { warnings.push(`${refs.join(", ")}: model unavailable (${declared}); provide the original model file.`); continue; }
      if (!recentlyMissing(declared, root) && (options.localOnly || networkUnavailable)) {
        pendingModels++;
        warnings.push(`${refs.join(", ")}: stock model is not available locally (${declared}).`);
        continue;
      }
      let path;
      try {
        path = await downloadStockModel(declared, { root, signal, ...(options.fetch ? { fetch: options.fetch } : {}) });
      } catch (error) {
        signal.throwIfAborted();
        if (!options.allowOffline) throw error;
        if (error instanceof TypeError || error instanceof Error && ["TimeoutError", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ConnectionRefused", "FailedToOpenSocket"].includes((error as NodeJS.ErrnoException).code ?? error.name)) networkUnavailable = true;
        pendingModels++;
        warnings.push(`${refs.join(", ")}: could not fetch ${declared}. ${error instanceof Error ? error.message : "Try again when online."}`);
        continue;
      }
      if (!path) warnings.push(`${refs.join(", ")}: exact stock model unavailable (${declared}); no substitute was used.`);
    }
  });
  try { await Promise.all(workers); } catch (error) { cancellation.abort(error); await Promise.allSettled(workers); throw error; }
  options.signal?.throwIfAborted();
  return { warnings: warnings.sort(), pendingModels };
}
