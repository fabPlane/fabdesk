import { cacheWriteCompleted, withModelCache } from "./model-cache-budget";
import { fabdeskHome } from "@fabdesk/auth-client";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync, utimesSync } from "node:fs";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Peeled official release tags; never fetch a moving branch or a URL supplied by a project.
export const STOCK_MODEL_COMMITS: Readonly<Record<string, string>> = {
  "6": "1080b6e565e56bae9be46db2278a1542092d7a2d",
  "7": "3aa910dbe635fce72ae4e645d0984bbd1cc9dbe8",
  "8": "e8cbcb1e90d4962ac754faedae43632e3cd3abc9",
  "9": "d5db5cea003fe2b4b1c9b145f5fcbd5fdb48f8ca",
  "10": "ca5b7874dad95c1c36b7ad8db6ca6b82e4a2a89e",
};
const SOURCE = "https://gitlab.com/kicad/libraries/kicad-packages3D";
const MAX_BYTES = 50 * 1024 * 1024;
export const stockModelCacheRoot = (env: NodeJS.ProcessEnv = process.env) => join(fabdeskHome(env), "cache", "kicad-models");
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export type StockModel = { commit: string; path: string };

/** Only an exact official library/file reference is eligible. No custom paths, URLs or traversal. */
export function officialStockModel(declared: string): StockModel | null {
  const match = /^\$(?:\{KICAD(\d+)_3DMODEL_DIR\}|\(KICAD(\d+)_3DMODEL_DIR\))\/([A-Za-z0-9_+-]+(?:\.[A-Za-z0-9_+-]+)*\.3dshapes)\/([A-Za-z0-9_+.,() -]+\.(?:step|stp|wrl))$/.exec(declared);
  const commit = match && STOCK_MODEL_COMMITS[match[1] ?? match[2]!];
  if (!match || !commit) return null;
  // KiCad's native --subst-models uses the same-named STEP for a WRL declaration.
  return { commit, path: `${match[3]}/${match[4]}`.replace(/\.wrl$/, ".step") };
}
const refPath = (root: string, model: StockModel) => join(root, "refs", `${model.commit}-${sha(model.path)}.json`);
export const stockModelUrl = (model: StockModel) => `${SOURCE}/-/raw/${model.commit}/${model.path.split("/").map(encodeURIComponent).join("/")}`;
type Receipt = { commit: string; path: string; sha256: string; bytes: number };
const verified = new Map<string, string>();

/** Local-only lookup: checksum validation never causes a network request. */
export function cachedStockModel(declared: string, root = stockModelCacheRoot()): string | null {
  const model = officialStockModel(declared);
  if (!model) return null;
  try {
    const receipt = JSON.parse(readFileSync(refPath(root, model), "utf8")) as Receipt;
    if (receipt.commit !== model.commit || receipt.path !== model.path || !/^[a-f0-9]{64}$/.test(receipt.sha256) || receipt.bytes <= 0 || receipt.bytes > MAX_BYTES) return null;
    const path = join(root, "objects", `${receipt.sha256}.step`), info = statSync(path);
    if (!info.isFile() || info.size !== receipt.bytes) return null;
    const stamp = `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${receipt.sha256}`;
    if (verified.get(path) !== stamp) {
      if (sha(readFileSync(path)) !== receipt.sha256) return null;
      if (verified.size > 4096) verified.clear();
      verified.set(path, stamp);
    }
    const ref = refPath(root, model);
    const now = Date.now();
    if (now - statSync(ref).mtimeMs > 60_000) {
      try { utimesSync(ref, now / 1000, now / 1000); } catch { /* A read-only cache is still usable. */ }
    }
    return path;
  } catch { return null; }
}

export type ModelFetch = (url: string, options: { signal: AbortSignal; redirect: "error" }) => Promise<Response>;
type Flight = { controller: AbortController; promise: Promise<string | null>; users: number };
const flights = new Map<string, Flight>();
const missingUntil = new Map<string, number>();
export function recentlyMissing(declared: string, root: string) {
  const model = officialStockModel(declared);
  return !!model && (missingUntil.get(refPath(root, model)) ?? 0) > Date.now();
}

/** One request per exact model in flight; one content-addressed object across projects/versions. */
export async function downloadStockModel(declared: string, options: { root?: string; signal?: AbortSignal; fetch?: ModelFetch } = {}): Promise<string | null> {
  options.signal?.throwIfAborted();
  const root = options.root ?? stockModelCacheRoot(), model = officialStockModel(declared);
  if (!model) return null;
  const cached = cachedStockModel(declared, root);
  if (cached) return cached;
  if (recentlyMissing(declared, root)) return null;
  const key = refPath(root, model);
  let flight = flights.get(key);
  if (!flight) {
    const controller = new AbortController();
    flight = { controller, users: 0, promise: withModelCache(root, () => fetchModel(model, root, controller.signal, options.fetch ?? fetch)) };
    flights.set(key, flight);
    const current = flight;
    void flight.promise.finally(() => { if (flights.get(key) === current) flights.delete(key); }).catch(() => {});
  }
  flight.users++;
  const current = flight;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      current.promise,
      new Promise<never>((_, reject) => {
        abort = () => reject(options.signal?.reason ?? new Error("Model download cancelled"));
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
      }),
    ]);
  } finally {
    if (abort) options.signal?.removeEventListener("abort", abort);
    if (--current.users === 0) { current.controller.abort(); if (flights.get(key) === current) flights.delete(key); }
  }
}

async function fetchModel(model: StockModel, root: string, cancellation: AbortSignal, request: ModelFetch): Promise<string | null> {
  const signal = AbortSignal.any([cancellation, AbortSignal.timeout(30_000)]);
  signal.throwIfAborted();
  const response = await request(stockModelUrl(model), { signal, redirect: "error" });
  if (response.status === 404) {
    await response.body?.cancel();
    if (missingUntil.size >= 4096) missingUntil.delete(missingUntil.keys().next().value!);
    missingUntil.set(refPath(root, model), Date.now() + 60 * 60_000);
    return null;
  }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Stock model download failed (${response.status}). Retry when online.`); }
  if (Number(response.headers.get("content-length")) > MAX_BYTES) { await response.body?.cancel(); throw new Error("Stock model exceeds the 50 MB limit"); }
  if (!response.body) throw new Error("Stock model response was empty");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > MAX_BYTES) throw new Error("Stock model exceeds the 50 MB limit");
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const data = Buffer.concat(chunks);
  if (!data.subarray(0, 256).toString().trimStart().startsWith("ISO-10303-21;") || !data.subarray(-512).toString().includes("END-ISO-10303-21;"))
    throw new Error("Stock model response was not a complete STEP file");
  signal.throwIfAborted();
  const digest = sha(data), objectDir = join(root, "objects"), refs = join(root, "refs");
  await mkdir(objectDir, { recursive: true }); await mkdir(refs, { recursive: true });
  const object = join(objectDir, `${digest}.step`), temporary = join(objectDir, `${randomUUID()}.tmp`);
  const receiptTemporary = join(refs, `${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, data, { flag: "wx" });
    signal.throwIfAborted();
    try { await link(temporary, object); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A partial/corrupt cache entry must not become trusted merely because it exists.
      if (sha(await readFile(object)) !== digest) await rename(temporary, object);
    }
    await writeFile(receiptTemporary, JSON.stringify({ ...model, sha256: digest, bytes, source: stockModelUrl(model), license: `${SOURCE}/-/blob/${model.commit}/LICENSE.md` }));
    signal.throwIfAborted();
    await rename(receiptTemporary, refPath(root, model));
    cacheWriteCompleted(root);
    return object;
  } finally { await rm(temporary, { force: true }); await rm(receiptTemporary, { force: true }); }
}
