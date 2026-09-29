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

/** Three resizable panes: thread sidebar | chat | board panel. */
export function AppShell({ onNewChat, coreStatus, banner }: AppShellProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const [shellWidth, setShellWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setShellWidth(Math.max(1, entry.contentRect.width));
    });
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);
  const percent = (pixels: number) => (pixels / Math.max(760, shellWidth)) * 100;
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
        <PanelGroup direction="horizontal" autoSaveId="fabdesk-shell">
          {sidebarOpen && (
            <>
              <Panel id="sidebar" order={1} defaultSize={percent(240)} minSize={percent(190)} maxSize={percent(280)}>
                <ThreadSidebar onNewChat={onNewChat} />
              </Panel>
              <Handle />
            </>
          )}
          <Panel id="chat" order={2} minSize={percent(300)}>
            {center}
          </Panel>
          {boardOpen && !openSourceId && !inventory && !orderFlowOpen && (
            <>
              <Handle />
              <Panel id="board" order={3} defaultSize={40} minSize={percent(260)}>
                <BoardPanel />
              </Panel>
            </>
          )}
        </PanelGroup>
      </div>
      <ProjectPickerDialog />
    </div>
  );
}
