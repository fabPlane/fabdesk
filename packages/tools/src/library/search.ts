/** Full-text search over library filenames, tags, and extracted file/PDF page text. */
import { readFile } from "node:fs/promises";
import type { LibrarySearchHit } from "@fabdesk/protocol";
import { jailPath } from "../fs";
import { extractPdfPageText } from "./pdf-text";
import { listLibrary, type LibraryListedEntry, type LibraryRoot } from "./store";

const TEXT_EXT = new Set([".md", ".txt", ".csv", ".json", ".c", ".h", ".cpp", ".ts", ".py", ".svg"]);
const MAX_TEXT_BYTES = 1_000_000;

export function libraryQueryTokens(q: string): string[] {
  return q
    .split(/\s+/)
    .map((token) => token.replace(/["']/g, "").trim().toLowerCase())
    .filter(Boolean);
}

function snippet(hay: string, tokens: string[]): string {
  const lower = hay.toLowerCase();
  const first = tokens.map((token) => lower.indexOf(token)).find((index) => index >= 0) ?? 0;
  const start = Math.max(0, first - 40);
  const slice = hay.slice(start, start + 220).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + slice + (start + 220 < hay.length ? "…" : "");
}

function matches(hay: string, tokens: string[]): boolean {
  const lower = hay.toLowerCase();
  return tokens.every((token) => lower.includes(token));
}

async function pageTexts(project: LibraryRoot, entry: LibraryListedEntry): Promise<Array<{ page: number | null; text: string }>> {
  const abs = await jailPath(project.dir, entry.path);
  const ext = entry.path.includes(".") ? `.${entry.path.split(".").pop()!.toLowerCase()}` : "";
  if (ext === ".pdf") {
    const data = await readFile(abs);
    const pages = extractPdfPageText(data);
    return pages.length ? pages.map((page) => ({ page: page.page, text: page.text })) : [{ page: null, text: "" }];
  }
  if (TEXT_EXT.has(ext)) {
    const st = await readFile(abs);
    if (st.byteLength > MAX_TEXT_BYTES) return [{ page: null, text: "" }];
    return [{ page: null, text: st.toString("utf8") }];
  }
  return [{ page: null, text: "" }];
}

export async function searchLibrary(
  project: LibraryRoot,
  q: string,
  opts: { ref?: string; limit?: number } = {},
): Promise<LibrarySearchHit[]> {
  const tokens = libraryQueryTokens(q);
  const listed = await listLibrary(project);
  const limit = opts.limit ?? 20;
  const hits: LibrarySearchHit[] = [];
  for (const entry of listed) {
    if (opts.ref && !entry.linkedRefs.some((ref) => ref.toLowerCase() === opts.ref!.toLowerCase())) continue;
    const meta = `${entry.title}\n${entry.path}\n${entry.tags.join(" ")}\n${entry.linkedRefs.join(" ")}\n${entry.linkedMpns.join(" ")}`;
    const pages = await pageTexts(project, entry);
    if (tokens.length === 0) {
      hits.push({
        id: entry.id,
        path: entry.path,
        title: entry.title,
        kind: entry.kind,
        page: null,
        snippet: entry.tags.join(", ") || entry.folder,
        linkedRefs: entry.linkedRefs,
      });
    } else {
      const metaHit = matches(meta, tokens);
      if (metaHit) {
        hits.push({
          id: entry.id,
          path: entry.path,
          title: entry.title,
          kind: entry.kind,
          page: null,
          snippet: snippet(meta, tokens),
          linkedRefs: entry.linkedRefs,
        });
        if (hits.length >= limit) return hits;
      }
      for (const page of pages) {
        if (!page.text || !matches(page.text, tokens)) continue;
        if (page.page === null && metaHit) continue;
        hits.push({
          id: entry.id,
          path: entry.path,
          title: entry.title,
          kind: entry.kind,
          page: page.page,
          snippet: snippet(page.text, tokens),
          linkedRefs: entry.linkedRefs,
        });
        if (hits.length >= limit) return hits;
      }
    }
    if (hits.length >= limit) return hits;
  }
  return hits;
}

export async function citeLibrary(
  project: LibraryRoot,
  id: string,
  page?: number,
): Promise<{ entry: LibraryListedEntry; page: number | null; text: string } | null> {
  const entry = (await listLibrary(project)).find((item) => item.id === id);
  if (!entry) return null;
  const pages = await pageTexts(project, entry);
  const chosen =
    page !== undefined ? (pages.find((item) => item.page === page) ?? null) : (pages[0] ?? null);
  if (!chosen) return { entry, page: null, text: "" };
  return { entry, page: chosen.page, text: chosen.text.slice(0, 4000) };
}
