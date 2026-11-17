/**
 * Read-only public part lookups (LCSC product detail, JLC parts search, EasyEDA component data) with an evidence cache.
 * Every raw response is kept in `cacheDir` with its URL and fetch time: that file is the evidence link of a BOM record.
 * An optional shared cache (`FABDESK_BOARD_FETCH_CACHE`, or `shared`) serves records younger than `maxAgeDays` (default 7)
 * across runs and projects; a record is copied into `cacheDir` so each package still carries its evidence. Failed
 * fetches are never shared and are retried.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const LCSC_URL = (code: string) => `https://wmsc.lcsc.com/ftps/wm/product/detail?productCode=${code}`;
export const JLC_URL = "https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList";
export const EDA_URL = (code: string) => `https://easyeda.com/api/products/${code}/components?version=6.4.19.5`;

const UA = { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) bom-check", Accept: "application/json" };

export type FetchRecord = { url: string; post: unknown; fetched: string; body: unknown };
export type JsonObj = Record<string, any>;

const isError = (b: unknown) => !!b && typeof b === "object" && "_error" in (b as object);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface FetchOptions {
  offline?: boolean;
  shared?: string | null;
  maxAgeDays?: number;
  /** Replace the network (tests). */
  transport?: (url: string, data: unknown) => Promise<unknown>;
  /** Pause between live requests in ms (default 300; EasyEDA 1200). Tests pass 0. */
  paceMs?: number | null;
  signal?: AbortSignal;
}

export class Fetch {
  calls = 0;
  reused = 0;
  private readonly shared: string | null;
  private readonly maxAgeMs: number;
  constructor(
    readonly cacheDir: string,
    private readonly opts: FetchOptions = {},
  ) {
    this.shared = opts.shared !== undefined ? opts.shared : process.env["FABDESK_BOARD_FETCH_CACHE"] || null;
    this.maxAgeMs = (opts.maxAgeDays ?? Number(process.env["FABDESK_BOARD_FETCH_MAX_DAYS"] ?? 7)) * 86400_000;
  }

  private async read(path: string): Promise<FetchRecord | null> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as FetchRecord;
    } catch {
      return null;
    }
  }

  async get(key: string, url: string, data?: unknown): Promise<FetchRecord | null> {
    await mkdir(this.cacheDir, { recursive: true });
    const name = key.replace(/[^A-Za-z0-9_.-]+/g, "_") + ".json";
    const f = join(this.cacheDir, name);
    const local = await this.read(f);
    if (local && (!isError(local.body) || this.opts.offline)) return local; // failed fetches are retried, not trusted
    if (this.shared) {
      const sf = join(this.shared, name);
      const rec = await this.read(sf);
      if (rec && !isError(rec.body)) {
        const age = Date.now() - (await stat(sf)).mtimeMs;
        if (age < this.maxAgeMs) {
          await writeFile(f, JSON.stringify(rec) + "\n");
          this.reused++;
          return rec;
        }
      }
    }
    if (this.opts.offline) return null;
    let body: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        body = this.opts.transport ? await this.opts.transport(url, data) : await liveFetch(url, data, this.opts.signal);
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        body = { _error: msg };
        if (this.opts.signal?.aborted) break;
        // 403/429 = rate limit: back off
        await sleep((this.opts.paceMs === 0 ? 0 : /403|429/.test(msg) ? 12_000 : 1_500) * (attempt + 1));
      }
    }
    this.calls++;
    await sleep(this.opts.paceMs ?? (url.includes("easyeda") ? 1200 : 300));
    const rec: FetchRecord = { url, post: data ?? null, fetched: new Date().toISOString(), body };
    await writeFile(f, JSON.stringify(rec) + "\n");
    if (this.shared && !isError(body)) {
      await mkdir(this.shared, { recursive: true });
      await writeFile(join(this.shared, name), JSON.stringify(rec) + "\n");
    }
    return rec;
  }
}

async function liveFetch(url: string, data: unknown, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(25_000);
  const r = await fetch(url, {
    method: data ? "POST" : "GET",
    headers: { ...UA, ...(data ? { "Content-Type": "application/json" } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!r.ok) throw new Error(`HTTP Error ${r.status}: ${r.statusText}`);
  return JSON.parse(await r.text());
}

/** JLC parts search for a keyword: the hit list and the raw record. */
export async function jlcSearch(fx: Fetch, kw: string): Promise<{ hits: JsonObj[]; raw: FetchRecord | null }> {
  const raw = await fx.get(`jlc-${kw}`, JLC_URL, { keyword: kw, currentPage: 1, pageSize: 25 });
  const list = (raw?.body as JsonObj | null)?.data?.componentPageInfo?.list;
  return { hits: Array.isArray(list) ? list : [], raw };
}

export interface EdaPad {
  n: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** JLC's own footprint pads (EasyEDA, 0.254 mm units), relative to the footprint origin, Y as drawn (down). */
export async function edaPads(fx: Fetch, code: string): Promise<{ pads: EdaPad[] | null; raw: FetchRecord | null; title: string | null }> {
  const raw = await fx.get(`eda-${code}`, EDA_URL(code));
  return edaPadsOf(raw);
}

export function edaPadsOf(raw: FetchRecord | null, flipY = false): { pads: EdaPad[] | null; raw: FetchRecord | null; title: string | null } {
  const detail = (raw?.body as JsonObj | null)?.result?.packageDetail as JsonObj | undefined;
  const ds = detail?.dataStr as JsonObj | undefined;
  if (!ds?.head) return { pads: null, raw, title: null };
  const ox = Number(ds.head.x);
  const oy = Number(ds.head.y);
  const pads: EdaPad[] = [];
  for (const s of (ds.shape ?? []) as string[]) {
    if (!s.startsWith("PAD~")) continue;
    const f = s.split("~");
    const [x, y, w, h] = [Number(f[2]), Number(f[3]), Number(f[4]), Number(f[5])];
    if (f.length < 9 || [x, y, w, h].some((v) => !Number.isFinite(v))) continue;
    pads.push({ n: f[8]!, x: (x - ox) * 0.254, y: (flipY ? -1 : 1) * (y - oy) * 0.254, w: w * 0.254, h: h * 0.254 });
  }
  return { pads, raw, title: (detail?.title as string | undefined) ?? null };
}

/** JLC/EasyEDA symbol: pin number -> upper-cased name (from the same components record as the footprint). */
export function edaPinNames(raw: FetchRecord | null): Record<string, string> {
  const shapes = (raw?.body as JsonObj | null)?.result?.dataStr?.shape as string[] | undefined;
  if (!Array.isArray(shapes)) return {};
  const out: Record<string, string> = {};
  for (const s of shapes) {
    if (!s.startsWith("P~")) continue;
    const num = s.split("~")[3]!;
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
