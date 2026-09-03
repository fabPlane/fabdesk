import { useMemo } from "react";
import { useRunTool } from "../board/tools";
import { composerHandlers } from "../chat/Composer";
import { useThreads, useThreadMutations } from "../hooks/queries";
import { useBranchThread } from "../hooks/threadActions";
import { useUiStore } from "../stores/ui";

/** App-level actions shared by the shortcut hook, the command palette and the top bar. */
export function useAppActions() {
  const threads = useThreads();
  const { patch } = useThreadMutations();
  const branch = useBranchThread();
  const { run } = useRunTool();
  const data = threads.data;
  return useMemo(() => {
    const ui = () => useUiStore.getState();
    const active = () => data?.find((t) => t.id === ui().activeThreadId);
    return {
      newChat() {
        ui().setActiveOpenSourceId(null);
        ui().setOrderFlowOpen(false);
        ui().setActiveThread(null);
        ui().setProjectPickerOpen(true);
      },
      send() {
        composerHandlers.send?.();
      },
      abort() {
        composerHandlers.abort?.();
      },
      async pinThread() {
        const t = active();
        if (t) await patch.mutateAsync({ id: t.id, patch: { pinned: !t.pinned } });
      },
      async branchThread() {
        const t = active();
        if (t) await branch(t);
      },
      openSketch() {
        ui().setSketchOpen(true);
      },
      openSettings() {
        ui().setSettingsOpen(true);
      },
      async routeBoard() {
        const projectId = ui().activeProjectId;
        if (!projectId) return;
        ui().setBoardTab("cinema");
        await run("route", { projectId });
      },
      async runDrc() {
        const projectId = ui().activeProjectId;
        if (!projectId) return;
        ui().setBoardTab("drc");
        await run("drc", { projectId });
      },
      async renderBoard() {
        const projectId = ui().activeProjectId;
        if (!projectId) return;
        ui().setBoardTab("renders");
        await run("render", { projectId });
      },
    };
  }, [data, patch, branch, run]);
}

export type AppActions = ReturnType<typeof useAppActions>;
