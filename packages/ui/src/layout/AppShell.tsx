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
import { useSlidingPane } from "./useSlidingPane";

function Handle({ open, moving, onResizeEnd }: { open: boolean; moving: boolean; onResizeEnd: () => void }) {
  return <PanelResizeHandle
    disabled={!open || moving}
    tabIndex={open ? 0 : -1}
    aria-hidden={!open}
    data-open={open}
    onDragging={(dragging) => { if (!dragging) onResizeEnd(); }}
    onKeyUp={onResizeEnd}
    className="fd-splitter fd-sliding-handle bg-border hover:bg-accent data-[resize-handle-active]:bg-accent"
  />;
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
  const sidebar = useSlidingPane(sidebarOpen, useUiStore((s) => s.setSidebarOpen));
  const boardVisible = boardOpen && !openSourceId && !inventory;
  const board = useSlidingPane(boardVisible, useUiStore((s) => s.setBoardOpen));
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
          <Panel ref={sidebar.panel} id="sidebar" order={1} collapsible
            className="fd-sliding-pane" data-side="left"
            defaultSize={percent(240)} minSize={percent(190)} maxSize={percent(280)}>
            <div ref={sidebar.content} className="fd-pane-content" inert={!sidebarOpen} aria-hidden={!sidebarOpen}>
              {sidebar.present && <ThreadSidebar onNewChat={onNewChat} />}
            </div>
          </Panel>
          <Handle open={sidebarOpen} moving={sidebar.moving} onResizeEnd={sidebar.syncOpen} />
          <Panel id="main" order={2} minSize={percent(300)}>
            <div ref={mainRef} className="h-full min-w-0">
              <PanelGroup direction="horizontal" autoSaveId="fabdesk-shell-content">
                <Panel id="chat" order={1} minSize={mainPercent(300)}>
                  {center}
                </Panel>
                <Handle open={boardVisible} moving={board.moving} onResizeEnd={board.syncOpen} />
                <Panel ref={board.panel} id="board" order={2} collapsible
                  className="fd-sliding-pane" data-side="right" defaultSize={40} minSize={mainPercent(260)}>
                  <div ref={board.content} className="fd-pane-content" inert={!boardVisible} aria-hidden={!boardVisible}>
                    {board.present && <BoardPanel />}
                  </div>
                </Panel>
              </PanelGroup>
            </div>
          </Panel>
        </PanelGroup>
      </div>
      <ProjectPickerDialog />
    </div>
  );
}
