import type { CoreClient } from "./CoreClient";

export type PcbDisplay = {
  modelPath: string;
  pcbRevision: string;
  coverage: { total: number; loaded: number; missing: string[] };
  warnings: string[];
  data: ArrayBuffer;
};
const pending = new Map<string, Promise<PcbDisplay>>();
/** Shared by assembly/enclosure. Revisions prevent old geometry following a newer PCB. */
export function loadPcbDisplay(
  client: CoreClient,
  projectId: string,
  path: string,
  pcbRevision: string,
  refresh = false,
): Promise<PcbDisplay> {
  const key = JSON.stringify([client.baseUrl, projectId, path, pcbRevision]);
  if (!refresh && pending.has(key)) return pending.get(key)!;
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
  while (pending.size > 8) pending.delete(pending.keys().next().value!);
  void request.catch(() => {
    if (pending.get(key) === request) pending.delete(key);
  });
  return request;
}
