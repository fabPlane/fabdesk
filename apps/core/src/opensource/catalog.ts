import { OpenCatalogIndex, type OpenCatalogEntry } from "@fabdesk/protocol";
import { filterCatalog, seedCatalogIndex } from "./seed";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function fetchOpenCatalog(
  apiOrigin: string,
  q?: string,
  fetchImpl: FetchLike = fetch,
): Promise<OpenCatalogIndex> {
  try {
    const url = new URL("/v1/public/catalog", apiOrigin.endsWith("/") ? apiOrigin : `${apiOrigin}/`);
    if (q?.trim()) url.searchParams.set("q", q.trim());
    const res = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(800) });
    if (res.ok) {
      const json: unknown = await res.json();
      const parsed = OpenCatalogIndex.safeParse(json);
      if (parsed.success && parsed.data.projects.length > 0) return parsed.data;
    }
  } catch {
    /* offline / old API — use the committed seed */
  }
  const seed = seedCatalogIndex();
  return { ...seed, projects: filterCatalog(seed.projects, q) };
}

export function findCatalogProject(index: OpenCatalogIndex, id: string): OpenCatalogEntry | undefined {
  const needle = id.trim().toLowerCase();
  return index.projects.find((project) => project.id.toLowerCase() === needle || `${project.ownerSlug}/${project.slug}`.toLowerCase() === needle);
}

export function allowedCloneUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "github.com" && parsed.pathname.endsWith(".git");
  } catch {
    return false;
  }
}
