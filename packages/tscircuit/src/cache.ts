/**
 * File-backed caches used during a build:
 *  - `FileCacheEngine` is the localStorage-like `LocalCacheEngine` @tscircuit/core consults from
 *    render phases (footprint/parts lookups, autorouter results).
 *  - `withRegistryFetchCache` wraps `globalThis.fetch` so @tsci/* registry and jsDelivr fetches made
 *    by @tscircuit/eval are served from disk on later builds.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface LocalCacheEngine {
  getItem(key: string): string | Promise<string | null> | null;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem?(key: string): void | Promise<void>;
}

function keyToFile(key: string): string {
  return Bun.hash(key).toString(16) + ".txt";
}

export class FileCacheEngine implements LocalCacheEngine {
  readonly dir: string;
  constructor(cacheDir: string) {
    this.dir = join(cacheDir, "render-cache");
  }
  async getItem(key: string): Promise<string | null> {
    const file = Bun.file(join(this.dir, keyToFile(key)));
    if (!(await file.exists())) return null;
    return file.text();
  }
  async setItem(key: string, value: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await Bun.write(join(this.dir, keyToFile(key)), value);
  }
  async removeItem(key: string): Promise<void> {
    const file = Bun.file(join(this.dir, keyToFile(key)));
    if (await file.exists()) await file.delete();
  }
}

const CACHEABLE_HOSTS = new Set(["cjs.tscircuit.com", "cdn.jsdelivr.net", "registry.tscircuit.com", "npm.tscircuit.com"]);

interface CachedResponse {
  url: string;
  status: number;
  contentType: string;
  body: string;
}

let installedFor: string | null = null;
let installDepth = 0;
let originalFetch: typeof globalThis.fetch | null = null;

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function isCacheable(url: string, init?: RequestInit): boolean {
  if (init?.method && init.method.toUpperCase() !== "GET") return false;
  if (init?.headers) {
    const headers = new Headers(init.headers);
    if (headers.has("authorization")) return false;
  }
  try {
    return CACHEABLE_HOSTS.has(new URL(url).host);
  } catch {
    return false;
  }
}

/**
 * Runs `fn` with a caching `globalThis.fetch` for registry hosts. Nested/concurrent builds sharing
 * the same cacheDir share one wrapper; a different cacheDir while one is active falls back to
 * uncached fetches for that build.
 */
export async function withRegistryFetchCache<T>(cacheDir: string, fn: () => Promise<T>): Promise<T> {
  if (installedFor !== null && installedFor !== cacheDir) return fn();
  const dir = join(cacheDir, "registry");
  if (installDepth === 0) {
    originalFetch = globalThis.fetch;
    const base = originalFetch;
    installedFor = cacheDir;
    const cachedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = requestUrl(input);
      if (!isCacheable(url, init)) return base(input, init);
      const path = join(dir, keyToFile(url) + ".json");
      const file = Bun.file(path);
      if (await file.exists()) {
        try {
          const hit = (await file.json()) as CachedResponse;
          return new Response(hit.body, { status: hit.status, headers: { "content-type": hit.contentType } });
        } catch {
          // Corrupt entry: fall through to the network.
        }
      }
      const res = await base(input, init);
      if (res.ok) {
        const body = await res.clone().text();
        const entry: CachedResponse = {
          url,
          status: res.status,
          contentType: res.headers.get("content-type") ?? "text/plain",
          body,
        };
        await mkdir(dir, { recursive: true });
        await Bun.write(path, JSON.stringify(entry));
      }
      return res;
    };
    globalThis.fetch = cachedFetch as typeof globalThis.fetch;
  }
  installDepth++;
  try {
    return await fn();
  } finally {
    installDepth--;
    if (installDepth === 0 && originalFetch) {
      globalThis.fetch = originalFetch;
      originalFetch = null;
      installedFor = null;
    }
  }
}
