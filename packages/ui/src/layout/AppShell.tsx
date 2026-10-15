import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useEffect, useRef, useState } from "react";
import type { CoreStatusInfo } from "../app/types";
import { BoardPanel } from "../board/BoardPanel";
import { ProjectPickerDialog } from "../chat/ProjectPickerDialog";
import { ThreadView } from "../chat/ThreadView";
import { InventoryView } from "../inventory/InventoryView";
import { OpenSourceView } from "../opensource/OpenSourceView";
import { OrderFlow } from "../order/OrderFlow";
import { ThreadSidebar } from "../sidebar/ThreadSidebar";
import { useUiStore } from "../stores/ui";
import { TopBar } from "./TopBar";

function Handle() {
  return <PanelResizeHandle className="fd-splitter w-px bg-border transition-colors hover:bg-accent data-[resize-handle-active]:bg-accent" />;
}

export interface AppShellProps {
  onNewChat: () => void;
  coreStatus?: CoreStatusInfo | undefined;
  banner?: React.ReactNode;
}

/** Measure each split independently so its pixel minimums use its own width. */
function usePaneWidth(initialWidth: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initialWidth);
  useEffect(() => {
    const shell = ref.current;
    if (!shell) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let measuredWidth = shell.clientWidth;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      measuredWidth = Math.max(1, entry.contentRect.width);
      // Update minimums at most ten times a second during window resizing.
      if (timer === undefined) timer = setTimeout(() => {
        setWidth(measuredWidth);
        timer = undefined;
      }, 100);
    });
    observer.observe(shell);
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, []);
  return { ref, width };
}

/** The sidebar owns an outer split; only chat and board share the inner split. */
export function AppShell({ onNewChat, coreStatus, banner }: AppShellProps) {
  const { ref: shellRef, width: shellWidth } = usePaneWidth(window.innerWidth);
  const { ref: mainRef, width: mainWidth } = usePaneWidth(window.innerWidth - 240);
  const percent = (pixels: number) => (pixels / Math.max(760, shellWidth)) * 100;
  const mainPercent = (pixels: number) => (pixels / Math.max(560, mainWidth)) * 100;
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const boardOpen = useUiStore((s) => s.boardOpen);
  const openSourceId = useUiStore((s) => s.activeOpenSourceId);
  const orderFlowOpen = useUiStore((s) => s.orderFlowOpen);
  const inventory = useUiStore((s) => s.inventoryOpen);
  const center = orderFlowOpen ? (
    <OrderFlow />
  ) : inventory ? (
    <InventoryView />
  ) : openSourceId ? (
    <OpenSourceView />
  ) : (
    <ThreadView />
  );
  return (
    <div ref={shellRef} className="fd-workspace flex h-full flex-col">
      <TopBar coreStatus={coreStatus} />
      {banner}
      <div className="min-h-0 flex-1">
        <PanelGroup direction="horizontal" autoSaveId="fabdesk-shell-sidebar">
          {sidebarOpen && (
            <>
              <Panel id="sidebar" order={1} defaultSize={percent(240)} minSize={percent(190)} maxSize={percent(280)}>
                <ThreadSidebar onNewChat={onNewChat} />
              </Panel>
              <Handle />
            </>
          )}
          <Panel id="main" order={2} minSize={percent(300)}>
            <div ref={mainRef} className="h-full min-w-0">
              <PanelGroup direction="horizontal" autoSaveId="fabdesk-shell-content">
                <Panel id="chat" order={1} minSize={mainPercent(300)}>
                  {center}
                </Panel>
                {boardOpen && !openSourceId && !inventory && (
                  <>
                    <Handle />
                    <Panel id="board" order={2} defaultSize={40} minSize={mainPercent(260)}>
                      <BoardPanel />
                    </Panel>
                  </>
                )}
              </PanelGroup>
            </div>
          </Panel>
        </PanelGroup>
      </div>
      <ProjectPickerDialog />
    </div>
  );
}
