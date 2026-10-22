import { useMemo } from "react";
import { useRunTool } from "@fabdesk/client-core";
import { composerHandlers } from "../chat/Composer";
import { useThread, useThreadMutations } from "@fabdesk/client-core";
import { useBranchThread } from "../hooks/threadActions";
import { useUiStore } from "../stores/ui";
import { stencilThicknessMm } from "../stores/stencil-thickness";

/** App-level actions shared by the shortcut hook, the command palette and the top bar. */
export function useAppActions() {
  const activeThreadId = useUiStore((s) => s.activeThreadId);
  const activeThread = useThread(activeThreadId);
  const { patch } = useThreadMutations();
  const branch = useBranchThread();
  const { run } = useRunTool();
  const data = activeThread.data;
  return useMemo(() => {
    const ui = () => useUiStore.getState();
    const active = () => (data && data.id === ui().activeThreadId ? data : undefined);
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
      async exportStencil() {
        const projectId = ui().activeProjectId;
        if (!projectId) return;
        ui().setBoardTab("files");
        await run("stencil", { projectId, thicknessMm: stencilThicknessMm(ui().stencilThicknessByProject?.[projectId]) });
      },
      async exportLaserStencil() {
        const projectId = ui().activeProjectId;
        if (!projectId) return;
        ui().setBoardTab("files");
        await run("export_laser_stencil", { projectId, preset: "mylar-uv" });
      },
    };
  }, [data, patch, branch, run]);
}

export type AppActions = ReturnType<typeof useAppActions>;
