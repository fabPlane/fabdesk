/**
 * Keeps the previous copy of a render so a re-render can be compared with what it replaced.
 *
 * The daemon writes one file per view (`renders/top.png`) and overwrites it, so "before" has to be
 * captured on this side, at the moment a re-render is requested. The image goes to the OS cache
 * directory (evictable, never backed up) with a sidecar JSON carrying the mtime it was taken at;
 * `isPreviousRender` in src/lib/renders.ts decides whether it is still a meaningful "before".
 */
import type { FileEntry } from "@fabdesk/protocol";
import { useCoreClient } from "@fabdesk/client-core";
import { Directory, File, Paths } from "expo-file-system";
import { useCallback, useEffect, useState } from "react";
import { previousRenderKey, type PreviousRender } from "@/lib/renders";
import { useConnection } from "@/transport/CoreConnection";

const dir = () => new Directory(Paths.cache, "renders-before");

function files(projectId: string, path: string) {
  const key = previousRenderKey(projectId, path);
  const ext = path.slice(path.lastIndexOf(".")) || ".png";
  return { image: new File(dir(), `${key}${ext}`), meta: new File(dir(), `${key}.json`) };
}

export function readPreviousRender(projectId: string, path: string): PreviousRender | null {
  try {
    const { image, meta } = files(projectId, path);
    if (!image.exists || !meta.exists) return null;
    const parsed = JSON.parse(meta.textSync()) as { mtime?: unknown };
    return typeof parsed.mtime === "string" ? { uri: image.uri, mtime: parsed.mtime } : null;
  } catch {
    return null;
  }
}

/** Downloads the render as it is right now. Call before asking the daemon to render again. */
export async function stashCurrentRender(opts: {
  url: string;
  headers: Record<string, string>;
  projectId: string;
  entry: FileEntry;
}): Promise<void> {
  const { image, meta } = files(opts.projectId, opts.entry.path);
  dir().create({ intermediates: true, idempotent: true });
  await File.downloadFileAsync(opts.url, image, { headers: opts.headers, idempotent: true });
  meta.write(
    JSON.stringify({
      mtime: opts.entry.mtime,
      path: opts.entry.path,
      savedAt: new Date().toISOString(),
    }),
  );
}

/** The cached "before" for one render, re-read whenever the current file's mtime changes. */
export function usePreviousRender(
  projectId: string,
  entry: FileEntry | null,
): PreviousRender | null {
  const [prev, setPrev] = useState<PreviousRender | null>(null);
  const path = entry?.path ?? null;
  const mtime = entry?.mtime ?? null;
  useEffect(() => {
    setPrev(path ? readPreviousRender(projectId, path) : null);
  }, [projectId, path, mtime]);
  return prev;
}

/** `stashCurrentRender` bound to the live connection; resolves false when there was nothing to keep. */
export function useStashRender(projectId: string) {
  const client = useCoreClient();
  const { authHeaders } = useConnection();
  return useCallback(
    async (entry: FileEntry | null): Promise<boolean> => {
      if (!entry) return false;
      try {
        await stashCurrentRender({
          url: client.fileUrl(projectId, entry.path),
          headers: authHeaders,
          projectId,
          entry,
        });
        return true;
      } catch {
        // Losing the comparison is not worth blocking the render.
        return false;
      }
    },
    [client, authHeaders, projectId],
  );
}
