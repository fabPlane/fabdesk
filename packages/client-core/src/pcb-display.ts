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
    if (pending.get(key) === request) pending.delete(key);
  });
  return request;
}
