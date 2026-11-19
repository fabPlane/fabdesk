import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { componentModelEnvironment, componentModelLibraryRoots, type KicadCli } from "./cli";
import { readSavedBoardModels, resolveModelPath } from "./mechanical";
import { downloadStockModel, officialStockModel, stockModelCacheRoot, type ModelFetch } from "./stock-model-cache";

/** Resolve local models first, then fetch only exact missing official STEP models. */
export async function prepareBoardModels(cli: KicadCli, options: {
  board: string; modelProjectDir?: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv; fetch?: ModelFetch;
}): Promise<{ warnings: string[] }> {
  const env = componentModelEnvironment(options.env ?? process.env, cli.path);
  const projectDir = options.modelProjectDir ?? dirname(options.board), warnings: string[] = [];
  const references = new Map<string, string[]>();
  for (const fp of readSavedBoardModels(await readFile(options.board, "utf8"))) {
    if (fp.dnp) continue;
    if (!fp.models.length && !/mounting.?hole|fiducial/i.test(fp.footprint)) warnings.push(`${fp.ref ?? "(unreferenced)"}: no 3D model is assigned; add the exact part model.`);
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
  let next = 0;
  const cancellation = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, cancellation.signal]) : cancellation.signal;
  const workers = Array.from({ length: Math.min(3, queued.length) }, async () => {
    while (next < queued.length) {
      signal.throwIfAborted();
      const [declared, refs] = queued[next++]!;
      if (!officialStockModel(declared)) { warnings.push(`${refs.join(", ")}: model unavailable (${declared}); provide the original model file.`); continue; }
      const path = await downloadStockModel(declared, { root: stockModelCacheRoot(env), signal, ...(options.fetch ? { fetch: options.fetch } : {}) });
      if (!path) warnings.push(`${refs.join(", ")}: exact stock model unavailable (${declared}); no substitute was used.`);
    }
  });
  try { await Promise.all(workers); } catch (error) { cancellation.abort(error); await Promise.allSettled(workers); throw error; }
  options.signal?.throwIfAborted();
  return { warnings: warnings.sort() };
}
