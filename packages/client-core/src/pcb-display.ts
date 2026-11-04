import type { CoreClient } from "./CoreClient";

import type { PcbModelGap } from "@fabdesk/protocol";

export type PcbDisplay = {
  modelPath: string;
  pcbRevision: string;
  coverage: { total: number; loaded: number; missing: string[]; details?: PcbModelGap[] };
  warnings: string[];
  bounds?: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
  data: ArrayBuffer;
};

export type PcbDisplayRequest = { path: string; pcbRevision: string };
export type PcbModelReadiness = {
  exporter: { path: string; version: string } | null;
  suggested: { path: string; version: string } | null;
  boards: Array<{ path: string; savedWith: string | null; newer: boolean }>;
  needsSetup: boolean;
};
export function pcbReadinessResult(response: unknown): PcbModelReadiness {
  const envelope = response as {
    json?: PcbModelReadiness;
    isError?: boolean;
    result?: { json?: PcbModelReadiness; isError?: boolean };
  } | null;
  const output = envelope?.result ?? envelope;
  if (
    !output?.json ||
    output.isError ||
    !Array.isArray(output.json.boards) ||
    typeof output.json.needsSetup !== "boolean"
  )
    throw Error("Setup check unavailable. Refresh to retry; board exports are checked separately.");
  return output.json;
}
export type PcbDisplaySnapshot = { projectId: string; models: Record<string, PcbDisplay> };

/** Retain only geometry that still belongs to this exact project and PCB revision. */
export function currentPcbDisplays(
  previous: PcbDisplaySnapshot,
  projectId: string,
  boards: PcbDisplayRequest[],
): Record<string, PcbDisplay> {
  return Object.fromEntries(
    boards.flatMap((board) => {
      const model = previous.models[board.path];
      return previous.projectId === projectId && model?.pcbRevision === board.pcbRevision
        ? [[board.path, model]]
        : [];
    }),
  );
}

/** Refresh progressively without replacing other valid boards with placeholders. */
export async function refreshPcbDisplays(
  client: CoreClient,
  projectId: string,
  boards: PcbDisplayRequest[],
  options: {
    previous: PcbDisplaySnapshot;
    refresh: boolean;
    cancelled: () => boolean;
    publish: (models: Record<string, PcbDisplay>, error: string) => void;
  },
) {
  const next = currentPcbDisplays(options.previous, projectId, boards);
  const errors: string[] = [];
  if (options.cancelled()) return;
  options.publish({ ...next }, "");
  for (const board of boards) {
    if (options.cancelled()) return;
    // Selection changes and tab switches do not require exporting unchanged boards again.
    if (!options.refresh && next[board.path]) continue;
    try {
      const model = await loadPcbDisplay(
        client,
        projectId,
        board.path,
        board.pcbRevision,
        options.refresh,
      );
      next[board.path] = model;
    } catch (e) {
      const retained = next[board.path] ? " Keeping the loaded model for this PCB revision." : "";
      errors.push(`${board.path}: ${e instanceof Error ? e.message : String(e)}${retained}`);
    }
    if (options.cancelled()) return;
    options.publish({ ...next }, errors.join("\n"));
  }
}
const pending = new Map<string, Promise<PcbDisplay>>();
const sizes = new Map<string, number>();
function trimModels() {
  while (
    pending.size > 20 ||
    [...sizes.values()].reduce((n, size) => n + size, 0) > 160 * 1024 * 1024
  ) {
    const key = pending.keys().next().value;
    if (!key) break;
    pending.delete(key);
    sizes.delete(key);
  }
}
/** Shared by assembly/enclosure. Revisions prevent old geometry following a newer PCB. */
export function loadPcbDisplay(
  client: CoreClient,
  projectId: string,
  path: string,
  pcbRevision: string,
  refresh = false,
): Promise<PcbDisplay> {
  const key = JSON.stringify([client.baseUrl, projectId, path, pcbRevision]);
  if (!refresh && pending.has(key)) {
    const cached = pending.get(key)!;
    pending.delete(key);
    pending.set(key, cached);
    return cached;
  }
  const previous = pending.get(key);
  const previousSize = sizes.get(key);
  sizes.delete(key);
  const request = (async () => {
    const response = await client.callTool("render_glb", {
      projectId,
      boardPath: path,
      expectedPcbRevision: pcbRevision,
    });
    let output = response.result;
    if (response.jobId) {
      const job = await client.waitJob(response.jobId);
      if (job.status !== "done") throw new Error(job.error ?? "PCB model generation failed.");
      output = job.result;
    }
    const result = output as { json?: Omit<PcbDisplay, "data">; isError?: boolean } | undefined;
    const model = result?.json;
    if (result?.isError || !model?.modelPath || model.pcbRevision !== pcbRevision)
      throw new Error("PCB model does not match this design. Refresh and try again.");
    const blob = await client.readFileBlob(projectId, model.modelPath);
    if (blob.size > 50 * 1024 * 1024) throw new Error("PCB model exceeds the 50 MB viewer limit.");
    return { ...model, data: await blob.arrayBuffer() };
  })();
  pending.set(key, request);
  trimModels();
  void request.then(
    (model) => {
      if (pending.get(key) === request) {
        sizes.set(key, model.data.byteLength);
        trimModels();
      }
    },
    () => {},
  );
  void request.catch(() => {
    if (pending.get(key) === request) {
      pending.delete(key);
      // A failed explicit refresh must not evict a successfully loaded same-revision model.
      if (previous && previousSize !== undefined) {
        pending.set(key, previous);
        sizes.set(key, previousSize);
        trimModels();
      }
    }
  });
  return request;
}
