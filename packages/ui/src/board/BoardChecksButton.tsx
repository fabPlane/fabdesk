import type { BoardSourceSelection } from "@fabdesk/protocol";
import { restoreAssemblySelection, useBoardSources } from "@fabdesk/client-core";
import { Button } from "../components/ui";
import { useUiStore } from "../stores/ui";

/** Keep post-edit checks on the captured source and its currently owned physical instance. */
export function BoardChecksButton({ projectId, board }: { projectId: string; board?: BoardSourceSelection }) {
  const sources = useBoardSources(projectId);
  const activeProjectId = useUiStore(state => state.activeProjectId);
  const saved = useUiStore(state => state.assemblyBoardByProject[projectId]);
  const selection = sources.data ? restoreAssemblySelection(sources.data, saved) : null;
  const available = activeProjectId === projectId && !sources.isFetching && !sources.isError &&
    (board ? selection?.sourceId === board.sourceId && selection.manifestSha256 === board.manifestSha256 : sources.data?.mode === "single");
  return <Button size="sm" variant="ghost" disabled={!available} title={available ? "Review checks for this saved board" : "Reopen this board after its project sources have been checked"} onClick={() => {
    const state = useUiStore.getState();
    if (!available || state.activeProjectId !== projectId) return;
    // Re-read persisted selection at action time; another board may have been selected.
    if (board) {
      const current = sources.data && restoreAssemblySelection(sources.data, state.assemblyBoardByProject[projectId]);
      if (!current || current.sourceId !== board.sourceId || current.manifestSha256 !== board.manifestSha256) return;
    }
    state.setBoardTab("drc");
  }}>Open checks</Button>;
}
