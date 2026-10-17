import { Select, Tabs } from "../components/ui";
import { BoardPanelToggle } from "../components/BoardPanelToggle";
import { CircuitLogo } from "../components/CircuitLogo";
import { useCore } from "@fabdesk/client-core";
import { useProjectOrder, useProjects } from "@fabdesk/client-core";
import { BOARD_TABS, BOARD_TAB_LABELS, useUiStore, type BoardTab } from "../stores/ui";
import { modKey } from "../util";
import { CadTab } from "./CadTab";
import { CinemaTab } from "./cinema/CinemaTab";
import { DrcTab } from "./DrcTab";
import { ArtTab } from "./ArtTab";
import { FilesTab } from "./FilesTab";
import { RendersTab } from "./RendersTab";
import { ShoppingListTab } from "./ShoppingListTab";
import { SvgTab } from "./SvgTab";
import { ThreeDTab } from "./ThreeDTab";
import { OrderChecksButton } from "./OrderChecksButton";

function TabBody({ tab }: { tab: BoardTab }) {
  switch (tab) {
    case "schematic":
      return <SvgTab kind="schematic" />;
    case "pcb":
      return <SvgTab kind="pcb" />;
    case "cinema":
      return <CinemaTab />;
    case "3d":
      return <ThreeDTab />;
    case "cad":
      return <CadTab />;
    case "drc":
      return <DrcTab />;
    case "renders":
      return <RendersTab />;
    case "files":
      return <FilesTab />;
    case "art":
      return <ArtTab />;
    case "bom":
      return <ShoppingListTab />;
    default:
      return null;
  }
}

export function BoardPanel() {
  const { host } = useCore();
  const tab = useUiStore((s) => s.boardTab);
  const setBoardTab = useUiStore((s) => s.setBoardTab);
  const projectId = useUiStore((s) => s.activeProjectId);
  const setOrderFlowOpen = useUiStore((s) => s.setOrderFlowOpen);
  const order = useProjectOrder(projectId);
  const projects = useProjects();
  const project = projects.data?.find((item) => item.id === projectId);
  const mod = modKey(host.platform);
  return (
    <div className="fd-board-panel flex h-full min-w-0 flex-col bg-panel" data-testid="board-panel">
      <div className="fd-board-heading">
        <span className="fd-board-mark"><CircuitLogo width={22} height={22} viewBox="6 6 40 40" /></span>
        <div className="min-w-0 flex-1">
          <div className="fd-board-eyebrow">Board workspace</div>
          <div className="fd-board-title truncate" title={project?.name}>{project?.name ?? "Select a project"}</div>
        </div>
        <div className="fd-board-actions">
          {order.data && (order.data.hasKicadPcb || order.data.hasRouted || order.data.ready) && (
            <OrderChecksButton
              order={order.data}
              unavailable={order.isError}
              onClick={() => setOrderFlowOpen(true)}
            />
          )}
        </div>
        <BoardPanelToggle location="board" />
      </div>
      <div className="fd-board-controls flex shrink-0 items-center px-3">
        <Tabs
          className="fd-board-tabs min-w-0 flex-1"
          variant="underline"
          tabs={BOARD_TABS.map((id, i) => ({ id, label: BOARD_TAB_LABELS[id], hint: `${mod} + ${i + 1}` }))}
          value={tab}
          onChange={setBoardTab}
        />
        <label className="fd-board-compact min-w-0 flex-1 basis-44 items-center gap-2" data-testid="board-view-menu">
          <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.09em] text-muted">View</span>
          <Select
            value={tab}
            onChange={(e) => setBoardTab(e.target.value as BoardTab)}
            aria-label="Board view"
            className="h-8 min-w-0 flex-1 border-border bg-panel-2/70 text-xs font-medium"
          >
            {BOARD_TABS.map((id, i) => <option key={id} value={id}>{BOARD_TAB_LABELS[id]} · {mod} + {i + 1}</option>)}
          </Select>
        </label>
      </div>
      <div className="fd-board-stage min-h-0 flex-1">
        <TabBody tab={tab} />
      </div>
    </div>
  );
}
