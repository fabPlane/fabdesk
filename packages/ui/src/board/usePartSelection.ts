import { useContext } from "react";
import { ComparisonControls } from "./ComparisonControls";
import { useQuery } from "@tanstack/react-query";
import { inspectSelectionIndex, partScopeKey, useCoreClient, usePartSelection } from "@fabdesk/client-core";
import type { BoardSourceSelection } from "@fabdesk/protocol";
import { useUiStore } from "../stores/ui";

export type PartSelectionSource = { projectId: string; board?: BoardSourceSelection; enabled?: boolean };
export function useBoardPartSelection(source?: PartSelectionSource) {
  const comparison = useContext(ComparisonControls);
  const client = useCoreClient();
  const active = useUiStore(s => s.activeProjectId);
  const enabled = !!source && source.enabled !== false && active === source.projectId;
  const scope = source ? partScopeKey({ endpoint: client.baseUrl, projectId: source.projectId, ...(source.board ? { sourceId: source.board.sourceId, manifestSha256: source.board.manifestSha256 } : {}) }) : "";
  const index = useQuery({ queryKey: ["part-selection-index", source?.projectId, scope], queryFn: () => inspectSelectionIndex(client, source!.projectId, source!.board), enabled, staleTime: 30_000, retry: false });
  const ref = usePartSelection(s => s.selection?.scope === scope ? s.selection.ref : null);
  const ready = enabled && !index.isFetching && !index.isError && !!index.data;
  return { scope, ref, index, ready, linkedFocus: ready && comparison?.focus?.ref === ref && comparison.focus.origin !== comparison.view ? comparison.focus.id : null, select: (ref: string) => { if (ready && useUiStore.getState().activeProjectId === source?.projectId) { usePartSelection.getState().select(scope, ref); comparison?.onSelect(ref, comparison.view); } }, clear: () => usePartSelection.getState().clear(scope) };
}
