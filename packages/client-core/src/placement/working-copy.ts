import type { CoreClient } from "../CoreClient";
import { sha256Blob } from "../pcb-preview-revision";
import type { PlacementSource } from "./source";

export type PlacementCandidate = { path: string; sha256: string; revision: number; widthMm: number; heightMm: number };
/** Copy source assets with their existing paths. Never inherit generated checks or renders. */
export function placementWorkingFiles(files: { path: string; size: number }[]) {
  return files.filter(file => !file.path.split("/").some(segment => [".git", ".fabdesk", "node_modules", "__pycache__", "placement", "renders", "reports", "exports"].includes(segment)) && !/(^|\/)(fabdesk\.json|\.DS_Store)$|\.(lck|kicad_prl)$/i.test(file.path));
}
export class PlacementCopyError extends Error {
  constructor(message: string, public readonly projectId: string | null) { super(message); }
}
/** The original is read-only. A failed copy remains inspectable and is never activated. */
export async function createPlacementWorkingCopy(client: Pick<CoreClient, "getProject" | "createProject" | "readFileBlob" | "writeFile" | "request">, input: {
  source: PlacementSource; candidate: PlacementCandidate; name: string;
  onProgress?: (done: number, total: number) => void;
}) {
  const { source, candidate } = input;
  let created: string | null = null;
  try {
    if (!input.name.trim() || input.name.trim().length > 80) throw Error("Choose a project name between 1 and 80 characters.");
    if (![candidate.widthMm, candidate.heightMm].every(value => Number.isFinite(value) && value > 0)) throw Error("Export a new copy to record its dimensions before continuing.");
    const project = await client.getProject(source.projectId);
    const files = placementWorkingFiles(project.files);
    if (!files.some(file => file.path === source.path)) throw Error("The original source is missing. Recheck it before continuing.");
    if (files.length > 1000 || files.reduce((total, file) => total + file.size, 0) > 64 * 1024 * 1024) throw Error("This source set is too large for a working copy here (1,000 files / 64 MB). Ask the assistant to prepare a separate copy.");
    const [original, pcb] = await Promise.all([client.readFileBlob(source.projectId, source.path), client.readFileBlob(source.projectId, candidate.path)]);
    if (await sha256Blob(original) !== source.sha256) throw Error("The original PCB changed. Reopen Placement before creating a working copy.");
    if (await sha256Blob(pcb) !== candidate.sha256) throw Error("The exported copy changed. Export and review a new copy first.");
    const next = await client.createProject(input.name.trim());
    created = next.id;
    const copied: { path: string; sha256: string }[] = [];
    for (const file of files) {
      const bytes = await client.readFileBlob(source.projectId, file.path);
      if (file.path === source.path && await sha256Blob(bytes) !== source.sha256) throw Error("The original PCB changed while copying. The partial copy was not activated.");
      await client.writeFile(next.id, file.path, bytes);
      copied.push({ path: file.path, sha256: await sha256Blob(bytes) });
      input.onProgress?.(copied.length, files.length);
    }
    // A consistent source snapshot matters for hierarchical schematics and local models too.
    for (const file of copied) {
      if (await sha256Blob(await client.readFileBlob(source.projectId, file.path)) !== file.sha256) throw Error(`Source changed while copying: ${file.path}. The partial copy was not activated.`);
    }
    if (await sha256Blob(await client.readFileBlob(source.projectId, candidate.path)) !== candidate.sha256) throw Error("The exported PCB changed during copying. The partial copy was not activated.");
    const currentFiles = placementWorkingFiles((await client.getProject(source.projectId)).files).map(file => file.path).sort();
    if (JSON.stringify(currentFiles) !== JSON.stringify(files.map(file => file.path).sort())) throw Error("The source file set changed while copying. The partial copy was not activated.");
    await client.request(`/projects/${encodeURIComponent(next.id)}`, { method: "PATCH", json: { manifest: { board: { ...project.manifest.board, widthMm: candidate.widthMm, heightMm: candidate.heightMm } } } });
    await client.writeFile(next.id, source.path, pcb);
    if (await sha256Blob(await client.readFileBlob(next.id, source.path)) !== candidate.sha256) throw Error("Could not verify the working PCB after writing it.");
    await client.writeFile(next.id, "placement/working-copy.json", JSON.stringify({
      contract: "fabplane.placement-working-copy.v1", original: source, candidate,
      sourceFiles: copied, createdAt: new Date().toISOString(),
      status: "unrouted; source dependencies, electrical parity and manufacturing readiness require fresh checks",
    }, null, 2));
    return next;
  } catch (error) {
    throw new PlacementCopyError(`${error instanceof Error ? error.message : error}${created ? ` Working copy ${created} was kept for inspection; the original is unchanged.` : ""}`, created);
  }
}
