import type { CoreClient } from "./CoreClient";

export const OUTPUT_DOWNLOAD_LIMIT = 200 * 1024 * 1024;

/** Read a whole selection before offering a download; keep full paths for duplicate board filenames. */
export async function readOutputSelection(client: Pick<CoreClient, "readFileBlob">, projectId: string, files: readonly { path: string; size: number }[]) {
  const unique = [...new Map(files.map(file => [file.path, file])).values()];
  if (!unique.length) throw new Error("Select at least one output to download.");
  if (unique.length > 500 || unique.reduce((sum, file) => sum + file.size, 0) > OUTPUT_DOWNLOAD_LIMIT)
    throw new Error("This selection is too large for one download. Choose fewer files (up to 200 MB). The saved files are unchanged.");
  for (const file of unique) if (file.path.startsWith("/") || file.path.includes("\\") || file.path.includes("\0") || file.path.includes(":") || file.path.split("/").some(part => !part || part === "." || part === ".."))
    throw new Error("One selected output has an invalid project path. Refresh the library before downloading.");
  const entries: Array<{ name: string; data: Uint8Array }> = [];
  let size = 0;
  for (const file of unique) {
    const blob = await client.readFileBlob(projectId, file.path);
    size += blob.size;
    if (size > OUTPUT_DOWNLOAD_LIMIT) throw new Error("These files grew beyond 200 MB. Choose fewer outputs to download.");
    entries.push({ name: file.path, data: new Uint8Array(await blob.arrayBuffer()) });
  }
  return entries;
}
