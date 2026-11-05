import { captureAssemblySourceSelection, restoreAssemblySelection, useBoardSources } from "@fabdesk/client-core";
import { useEffect, useState } from "react";
import { useUiStore } from "../stores/ui";

/** One explicit source for output operations; removed or reassigned sources never become root work. */
export function useOutputSource(projectId: string) {
  const sources = useBoardSources(projectId), saved = useUiStore(state => state.assemblyBoardByProject[projectId]);
  const [requested, setRequested] = useState<{ sourceId: string; manifestSha256: string } | null>(null);
  const data = sources.data, assembly = data?.mode === "assembly";
  const restored = assembly ? restoreAssemblySelection(data, saved) : null;
  const sourceId = requested?.sourceId ?? restored?.sourceId ?? (assembly ? data.sources.find(row => row.status === "available")?.source.id : undefined);
  const row = assembly ? data.sources.find(row => row.source.id === sourceId) : undefined;
  const board = assembly && data.manifestSha256 && sourceId ? { sourceId, manifestSha256: requested?.manifestSha256 ?? restored?.manifestSha256 ?? data.manifestSha256 } : undefined;
  const prefix = row?.source.location === "project" && row.source.directory !== "." ? `${row.source.directory}/` : "";
  const ready = !!data && !sources.isFetching && !sources.isError && (data.mode === "single" || !!board && board.manifestSha256 === data.manifestSha256 && row?.status === "available" && row.source.location === "project" && !!row.pcbSha256);
  useEffect(() => { if (!requested && board) setRequested(board); }, [requested, board?.sourceId, board?.manifestSha256]);
  const choose = (id: string) => {
    if (!data?.manifestSha256 || sources.isFetching || sources.isError || useUiStore.getState().activeProjectId !== projectId) return;
    setRequested({ sourceId: id, manifestSha256: data.manifestSha256 });
    const ui = useUiStore.getState(), selection = captureAssemblySourceSelection(data, id, ui.assemblyBoardByProject[projectId]);
    if (selection) ui.setAssemblyBoard(selection);
  };
  return { sources, data, assembly, sourceId, row, board, prefix, ready, choose };
}
