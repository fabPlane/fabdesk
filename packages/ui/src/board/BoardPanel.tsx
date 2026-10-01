import { Button, IconButton, Select, Tabs } from "../components/ui";
import { Icon } from "../components/Icon";
import { useCore } from "@fabdesk/client-core";
import { useProjectOrder, useProjects } from "@fabdesk/client-core";
import { BOARD_TABS, BOARD_TAB_LABELS, useUiStore, type BoardTab } from "../stores/ui";
import { modKey } from "../util";
import { CadTab } from "./CadTab";
import { CinemaTab } from "./cinema/CinemaTab";
import { DrcTab } from "./DrcTab";
import { FilesTab } from "./FilesTab";
import { RendersTab } from "./RendersTab";
import { ShoppingListTab } from "./ShoppingListTab";
import { SvgTab } from "./SvgTab";
import { ThreeDTab } from "./ThreeDTab";

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
  const setBoardOpen = useUiStore((s) => s.setBoardOpen);
  const projectId = useUiStore((s) => s.activeProjectId);
  const setOrderFlowOpen = useUiStore((s) => s.setOrderFlowOpen);
  const order = useProjectOrder(projectId);
  const projects = useProjects();
  const project = projects.data?.find((item) => item.id === projectId);
  const mod = modKey(host.platform);
  return (
    <div className="fd-board-panel flex h-full min-w-0 flex-col bg-panel" data-testid="board-panel">
      <div className="fd-board-heading">
        <Icon name="panel" width={16} height={16} />
        <span>Board workspace</span>
        {project && <span className="ml-auto min-w-0 truncate text-[11px] text-muted" title={project.name}>{project.name}</span>}
      </div>
      <div className="fd-board-controls flex min-h-12 shrink-0 flex-wrap items-center gap-1.5 px-3 py-1.5">
        <Tabs
          className="fd-board-tabs min-w-0 flex-1"
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
        {order.data && (order.data.hasKicadPcb || order.data.hasRouted || order.data.ready) && (
          <Button
            size="sm"
            variant={order.data.ready ? "primary" : "secondary"}
            onClick={() => setOrderFlowOpen(true)}
            title={order.data.ready ? "Board checks passed" : order.data.reasons.join(" ")}
            data-testid="order-now"
          >
            {order.data.ready ? "Order now" : "Order checks"}
          </Button>
        )}
        <IconButton title={`Hide board panel (${mod} + Shift + B)`} onClick={() => setBoardOpen(false)}>
          <Icon name="close" />
        </IconButton>
      </div>
      <div className="fd-board-stage min-h-0 flex-1">
        <TabBody tab={tab} />
      </div>
    </div>
  );
}
