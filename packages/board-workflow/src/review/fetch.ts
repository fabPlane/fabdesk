/**
 * Outside evidence (JLC/EasyEDA symbols by LCSC code), fetched once and cached with its URL and time.
 * The record format is the toolkit's (`{url, post, fetched, body}`), so a cache from either side serves both.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const EDA_URL = (code: string) => `https://easyeda.com/api/products/${code}/components?version=6.4.19.5`;
const UA = { "User-Agent": "fabdesk-board-review/1.0 (+pin-name cross-check)" };

export interface FetchRecord {
  url: string;
  post?: unknown;
  fetched: string;
  body: unknown;
}

export const fetchCacheDir = () => process.env["FABDESK_FETCH_CACHE"] || join(homedir(), ".cache", "fabdesk", "lcsc");

const isError = (rec: FetchRecord | null) => !!rec && typeof rec.body === "object" && rec.body !== null && "_error" in (rec.body as object);

export class Fetch {
  calls = 0;
  constructor(
    readonly cache: string,
    readonly offline = false,
    private readonly signal?: AbortSignal,
  ) {}

  private file(key: string) {
    return join(this.cache, key.replace(/[^A-Za-z0-9_.-]+/g, "_") + ".json");
  }

  async get(key: string, url: string): Promise<FetchRecord | null> {
    await mkdir(this.cache, { recursive: true });
    const f = this.file(key);
    const text = await readFile(f, "utf8").catch(() => "");
    if (text) {
      const rec = JSON.parse(text) as FetchRecord;
      if (!isError(rec) || this.offline) return rec; // failed fetches are retried, not trusted
    }
    if (this.offline) return null;
    let body: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(url, { headers: UA, signal: AbortSignal.any([...(this.signal ? [this.signal] : []), AbortSignal.timeout(25_000)]) });
        if (!r.ok) throw new Error(`HTTP Error ${r.status}`);
        body = await r.json();
        break;
      } catch (e) {
        if (this.signal?.aborted) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        body = { _error: msg };
        await new Promise((z) => setTimeout(z, (/403|429/.test(msg) ? 12 : 1.5) * (attempt + 1) * 1000));
      }
    }
    this.calls++;
    await new Promise((z) => setTimeout(z, url.includes("easyeda") ? 1200 : 300)); // the source's rate limit
    const rec: FetchRecord = { url, post: null, fetched: new Date().toISOString(), body };
    await writeFile(f, JSON.stringify(rec) + "\n");
    return rec;
  }
}

/** JLC/EasyEDA symbol: pin number -> name (upper case), from the components record. */
export function edaPinNames(rec: FetchRecord | null): Record<string, string> {
  const shapes = (rec as { body?: { result?: { dataStr?: { shape?: unknown } } } } | null)?.body?.result?.dataStr?.shape;
  if (!Array.isArray(shapes)) return {};
  const out: Record<string, string> = {};
  for (const s of shapes as unknown[]) {
    if (typeof s !== "string" || !s.startsWith("P~")) continue;
    const num = s.split("~")[3] ?? "";
    for (const seg of s.split("^^")) {
      const f = seg.split("~");
      if (f.length > 4 && (f[0] === "0" || f[0] === "1") && f[4] && f[4] !== num) {
        out[num] = f[4].trim().toUpperCase();
        break;
      }
    }
  }
  return out;
}
