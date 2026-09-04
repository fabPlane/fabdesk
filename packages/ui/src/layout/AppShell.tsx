import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import type { CoreStatusInfo } from "../app/types";
import { BoardPanel } from "../board/BoardPanel";
import { ProjectPickerDialog } from "../chat/ProjectPickerDialog";
import { ThreadView } from "../chat/ThreadView";
import { OpenSourceView } from "../opensource/OpenSourceView";
import { OrderFlow } from "../order/OrderFlow";
import { ThreadSidebar } from "../sidebar/ThreadSidebar";
import { useUiStore } from "../stores/ui";
import { TopBar } from "./TopBar";

function Handle() {
  return <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-accent data-[resize-handle-active]:bg-accent" />;
}

export interface AppShellProps {
  onNewChat: () => void;
  coreStatus?: CoreStatusInfo | undefined;
  banner?: React.ReactNode;
}

/** Three resizable panes: thread sidebar | chat | board panel. */
export function AppShell({ onNewChat, coreStatus, banner }: AppShellProps) {
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const boardOpen = useUiStore((s) => s.boardOpen);
  const openSourceId = useUiStore((s) => s.activeOpenSourceId);
  const orderFlowOpen = useUiStore((s) => s.orderFlowOpen);
  const center = orderFlowOpen ? <OrderFlow /> : openSourceId ? <OpenSourceView /> : <ThreadView />;
  return (
    <div className="flex h-full flex-col">
      <TopBar coreStatus={coreStatus} />
      {banner}
      <div className="min-h-0 flex-1">
        <PanelGroup direction="horizontal" autoSaveId="fabdesk-shell">
          {sidebarOpen && (
            <>
              <Panel id="sidebar" order={1} defaultSize={18} minSize={12} maxSize={35}>
                <ThreadSidebar onNewChat={onNewChat} />
              </Panel>
              <Handle />
            </>
          )}
          <Panel id="chat" order={2} minSize={30}>
            {center}
          </Panel>
          {boardOpen && !openSourceId && (
            <>
              <Handle />
              <Panel id="board" order={3} defaultSize={40} minSize={20}>
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
