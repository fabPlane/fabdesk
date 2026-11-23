/** Allowlisted library payload for shared/public pages: metadata + excerpts, never local roots. */
import { readFile } from "node:fs/promises";
import { SharedLibraryItem, libraryMimeForName, type SharedLibraryItem as SharedItem } from "@fabdesk/protocol";
import { jailPath } from "../fs";
import { extractPdfPageText } from "./pdf-text";
import { listLibrary, type LibraryRoot } from "./store";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
/** Only these extensions contribute body text to a published snapshot. */
const SHARE_EXCERPT_EXT = new Set([".pdf", ".md", ".txt", ".csv"]);
const PREVIEW_MAX = 400_000;

export async function sharedLibraryItems(project: LibraryRoot): Promise<SharedItem[]> {
  const listed = await listLibrary(project);
  const items: SharedItem[] = [];
  for (const entry of listed.slice(0, 64)) {
    const abs = await jailPath(project.dir, entry.path);
    const data = await readFile(abs).catch(() => null);
    if (!data) continue;
    const ext = entry.path.includes(".") ? `.${entry.path.split(".").pop()!.toLowerCase()}` : "";
    let textExcerpt = "";
    let pageCount: number | null = null;
    if (ext === ".pdf") {
      const pages = extractPdfPageText(data);
      pageCount = pages.length || null;
      textExcerpt = pages
        .map((page) => page.text)
        .join(" ")
        .slice(0, 2000);
    } else if (SHARE_EXCERPT_EXT.has(ext) && data.byteLength <= 200_000) {
      textExcerpt = data.toString("utf8").slice(0, 2000);
    }
    let preview: SharedItem["preview"] = null;
    if (IMAGE_EXT.has(ext) && data.byteLength <= PREVIEW_MAX) {
      const contentType =
        ext === ".png"
          ? "image/png"
          : ext === ".webp"
            ? "image/webp"
            : ext === ".gif"
              ? "image/gif"
              : "image/jpeg";
      preview = { contentType, dataBase64: data.toString("base64") };
    }
    items.push(
      SharedLibraryItem.parse({
        id: entry.id,
        title: entry.title,
        path: entry.path,
        kind: entry.kind,
        folder: entry.folder,
        tags: entry.tags,
        linkedRefs: entry.linkedRefs,
        linkedMpns: entry.linkedMpns,
        mime: libraryMimeForName(entry.path),
        bytes: entry.bytes,
        pageCount,
        textExcerpt,
        preview,
      }),
    );
  }
  return items;
}
