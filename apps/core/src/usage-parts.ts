/** Complete logical records are committed only after every content-addressed part is accepted. */
import { createHash } from "node:crypto";

export function partReceiptPrefix(key: string): string {
  // Backfill snapshot ids and live run ids change, but both carry the same logical conversation.
  const thread = /^snapshots\/[^/]+\/conversations\/([^/]+)\.json$/.exec(key)?.[1]
    ?? /^conversations\/([^/]+)\/[^/]+\.json$/.exec(key)?.[1];
  return `usage_archive_part_${createHash("sha256").update(thread ? `conversation:${thread}` : key).digest("hex")}_`;
}
export const ARCHIVE_PART_BYTES = 512 * 1024;
export type ArchivePart = { key: string; bytes: number; sha256: string };
export type ArchiveRecord = {
  schema: "fabdesk.usage-record/v1";
  encoding: "chunked-base64";
  bytes: number;
  sha256: string;
  parts: ArchivePart[];
};
export type ArchiveChunk = {
  schema: "fabdesk.usage-chunk/v1";
  encoding: "base64";
  bytes: number;
  sha256: string;
  content: string;
};

/** Snapshot manifest paths are accepted by already-deployed ingress; no new route/credentials. */
export const partKey = (sha256: string) => `snapshots/chunk-${sha256}/manifest.json`;
