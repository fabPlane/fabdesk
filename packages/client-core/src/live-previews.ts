import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BoardLayers, BOARD_LAYERS_PATH, BoardModelRevision, BOARD_MODEL_REVISION_PATH, type BoardSourceSelection } from "@fabdesk/protocol";
import { CoreHttpError, type CoreClient } from "./CoreClient";
import { useCoreClient } from "./provider";
import { useBoardSources, useProject } from "./queries";
import { inspectPcbPreviewRevision, sha256Blob } from "./pcb-preview-revision";
import { inspectBoardModelRevision } from "./board-model-revision";
import { inspectAssemblyBoardModel } from "./assembly-board-model";
import { inspectAssemblySchematicPreview, inspectRootSchematicPreview } from "./assembly-schematic-preview";
import { captureAssemblySchematicInspection } from "./assembly-schematic-inspection";
import { previewQueue } from "./preview-queue";

export type PreviewKind = "pcb" | "schematic" | "layers" | "model";
export type PreviewScope = { projectId: string; directory?: string; board?: BoardSourceSelection; enabled?: boolean };
type PreviewResult = { model?: { blob: Blob; warnings: string[] }; layers?: BoardLayers; svg?: string; sheets?: Array<{ path: string; nativeSheet?: { identity: string } | undefined }> };
const priority: Record<PreviewKind, number> = { pcb: 0, schematic: 1, layers: 2, model: 3 };
const nativeInput = /(?:\.kicad_(?:pcb|sch|pro|dru|mod|sym)$|\.(?:step|stp|wrl)$|(?:^|\/)(?:fp-lib-table|sym-lib-table|fabdesk.json|fabplane.assembly.json)$)/i;
export function previewInputStamp(files: readonly { path: string; size: number; mtime: number | string }[]) {
  return JSON.stringify(files.filter(file => nativeInput.test(file.path) && !/(?:^|\/)(?:renders|exports|reports)\//.test(file.path))
    .map(file => [file.path, file.size, file.mtime]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

export async function runPreviewTool(client: Pick<CoreClient, "callTool" | "waitJob">, name: string, args: Record<string, unknown>) {
  const response = await client.callTool(name, args);
  if (response.jobId) {
    // Keep the queue occupied until the native process exits, even if its observer
    // leaves. The exporter checks captured bytes before publishing.
    const job = await client.waitJob(response.jobId);
    if (job.status !== "done") throw new Error(job.error ?? "Preview preparation stopped.");
    const result = job.result as { isError?: boolean; text?: string } | null;
    if (result?.isError) throw new Error(result.text ?? "Preview preparation failed.");
    return job.result;
  }
  // HTTP daemons can return the tool envelope directly; test/older clients wrap it.
  const value = "result" in response ? response.result : response;
  const result = value as { isError?: boolean; ok?: boolean; text?: string } | null;
  if (result?.isError || result?.ok === false) throw new Error(result.text ?? "Preview preparation failed.");
  return value;
}

export async function readBoardLayers(client: Pick<CoreClient, "readFile">, projectId: string, path: string, hash: string) {
  try {
    const parsed = BoardLayers.safeParse(JSON.parse(await client.readFile(projectId, path)));
    return parsed.success && parsed.data.sourceSha256 === hash ? parsed.data : null;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof CoreHttpError && error.status === 404) return null;
    throw error;
  }
}

/** Shared by warm-up and every viewer. Events handle local saves; a quiet poll
 * detects changed external model libraries and reconnects without a render loop. */
export function useLivePreview(kind: PreviewKind, { projectId, directory = ".", board, enabled = true }: PreviewScope) {
  const client = useCoreClient(), queries = useQueryClient();
  const project = useProject(projectId || null), sources = useBoardSources(projectId || null);
  const prefix = directory === "." ? "" : `${directory}/`;
  const files = project.data?.files ?? [];
  const stamp = previewInputStamp(files);
  const [settled, setSettled] = useState(stamp);
  useEffect(() => { const timer = setTimeout(() => setSettled(stamp), 500); return () => clearTimeout(timer); }, [stamp]);
  const member = sources.data?.sources.find(row => row.source.id === board?.sourceId);
  const owned = board ? sources.data?.manifestSha256 === board.manifestSha256 && member?.status === "available" && member.source.location === "project" && member.source.directory === directory : sources.data?.mode === "single" && directory === ".";
  const scope = [projectId, client.baseUrl, directory, board?.sourceId ?? "root", board?.manifestSha256 ?? ""];
  const sourcePath = prefix + (kind === "schematic" ? "board.kicad_sch" : "board.kicad_pcb");
  const available = !!projectId && enabled && owned && !sources.isError && !project.isError && files.some(file => file.path === sourcePath);
  const inputs = useQuery({ queryKey: ["preview-inputs", ...scope, settled], enabled: available && settled === stamp,
    staleTime: 10_000, refetchInterval: 15_000, retry: false,
    queryFn: async () => {
      const native = files.filter(file => (file.path === prefix + "board.kicad_pcb" || file.path.startsWith(prefix) && file.path.endsWith(".kicad_sch")) && !/(?:^|\/)(?:renders|exports|reports)\//.test(file.path)).sort((a, b) => a.path.localeCompare(b.path));
      const hashes: Record<string, string> = {};
      for (const file of native) hashes[file.path] = await sha256Blob(await client.readFileBlob(projectId, file.path));
      const dependencies = await client.inspectOutputDependencies(projectId, directory);
      return { hashes, dependencies: dependencies.revision, revision: JSON.stringify([hashes, dependencies.revision]) };
    },
  });
  const captured = inputs.data;
  const revision = kind === "schematic" ? captured?.revision : captured && JSON.stringify([captured.hashes[prefix + "board.kicad_pcb"], captured.dependencies]);
  const preview = useQuery<PreviewResult>({ queryKey: ["live-preview", ...scope, kind, revision],
    enabled: available && settled === stamp && !!captured && !inputs.isError,
    staleTime: Infinity, gcTime: 5 * 60_000, retry: false, retryOnMount: false,
    // Do not retain another board's data when navigation changes source scope.
    placeholderData: (previous, query) => JSON.stringify(query?.queryKey.slice(1, 7)) === JSON.stringify([...scope, kind]) ? previous : undefined,
    queryFn: ({ signal }) => previewQueue(client.baseUrl).enqueue(priority[kind], signal, async () => {
      signal.throwIfAborted();
      // Waiting work must not render a later edit under an earlier cache key.
      for (const [path, expected] of Object.entries(captured!.hashes)) {
        if (kind !== "schematic" && path !== prefix + "board.kicad_pcb") continue;
        if (await sha256Blob(await client.readFileBlob(projectId, path)) !== expected)
          throw new Error("Source changed; preparing the latest saved version.");
      }
      const args = { projectId, ...(board ? { board } : {}) };
      const hash = captured!.hashes[prefix + "board.kicad_pcb"];
      let changed = false;
      const run = async (name: string, extra: Record<string, unknown> = {}) => {
        signal.throwIfAborted();
        await runPreviewTool(client, name, { ...args, ...extra }); changed = true;
      };
      let result: PreviewResult = {};
      try {
        if (kind === "schematic") {
          let saved = board ? await inspectAssemblySchematicPreview(client, projectId, board) : await inspectRootSchematicPreview(client, projectId);
          if (saved.state !== "source-unchanged" || !saved.svg?.includes('data-fabplane-schematic-view="circuit')) {
            const extra: Record<string, unknown> = { circuit: true };
            if (board) {
              const inspection = captureAssemblySchematicInspection(await runPreviewTool(client, "schematic_inspect", { ...args, detail: "summary" }), projectId, board);
              if (!inspection.hierarchy.complete) throw new Error("A referenced schematic sheet is missing. Restore it to prepare the preview.");
              extra.expectedHierarchyRevision = inspection.hierarchy.aggregateRevision;
            }
            await run("render_schematic_svg", extra);
            saved = board ? await inspectAssemblySchematicPreview(client, projectId, board) : await inspectRootSchematicPreview(client, projectId);
          }
          if (saved.state !== "source-unchanged" || !saved.svg) throw new Error("Schematic changed while preparing its preview.");
          result = { svg: saved.svg, sheets: saved.sheets };
        } else if (kind === "pcb") {
          if (await inspectPcbPreviewRevision(client, projectId, directory, hash) !== "matches-source") await run("render_pcb_svg", { expectedSourceSha256: hash });
          result = { svg: await client.readFile(projectId, prefix + "renders/pcb.svg") };
        } else if (kind === "layers") {
          let saved = await readBoardLayers(client, projectId, prefix + BOARD_LAYERS_PATH, hash!);
          if (!saved) { await run("render_board_layers", { expectedSourceSha256: hash }); saved = await readBoardLayers(client, projectId, prefix + BOARD_LAYERS_PATH, hash!); }
          if (!saved) throw new Error("Layers changed during preview preparation.");
          result = { layers: saved };
        } else {
          // Root and member receipts both carry the dependency snapshot.
          if (board) {
            let saved = await inspectAssemblyBoardModel(client, projectId, board);
            if (saved.state !== "source-unchanged") { await run("render_glb", { expectedSourceSha256: hash }); saved = await inspectAssemblyBoardModel(client, projectId, board); }
            if (saved.state !== "source-unchanged" || !saved.model || saved.sourceSha256 !== hash) throw new Error("Model changed during preparation.");
            result = { model: { blob: saved.model, warnings: saved.warnings } };
          } else {
            if (await inspectBoardModelRevision(client, projectId) !== "source-unchanged") await run("render_glb", { expectedSourceSha256: hash });
            if (await inspectBoardModelRevision(client, projectId) !== "source-unchanged") throw new Error("Model changed during preparation.");
            const receipt = BoardModelRevision.parse(JSON.parse(await client.readFile(projectId, BOARD_MODEL_REVISION_PATH)));
            const blob = await client.readFileBlob(projectId, "renders/board.glb");
            if (receipt.sourceSha256 !== hash || await sha256Blob(blob) !== receipt.artifactSha256) throw new Error("Model changed while opening it.");
            result = { model: { blob, warnings: receipt.warnings ?? [] } };
          }
        }
        signal.throwIfAborted();
        return result;
      } finally {
        if (changed) {
          // Tool completion can race the final file-watcher notification.
          for (const key of ["file", "project", "pcb-preview-revision", "board-model-revision", "assembly-board-model", "root-schematic-preview", "assembly-schematic-preview", "board-sources"])
            void queries.invalidateQueries({ queryKey: [key, projectId] });
        }
      }
    }),
  });
  return { ...preview, available, updating: available && (settled !== stamp || inputs.isPending || preview.isFetching || preview.isPlaceholderData),
    error: inputs.error ?? preview.error, retry: () => inputs.isError ? inputs.refetch() : preview.refetch() };
}
