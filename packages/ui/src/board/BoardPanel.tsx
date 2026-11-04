import { Tabs } from "../components/ui";
import { lazy, Suspense } from "react";
import { BoardViewMenu } from "./BoardViewMenu";
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
import { NotesTab } from "./NotesTab";
import { RendersTab } from "./RendersTab";
import { DiffTab } from "./DiffTab";
import { ShoppingListTab } from "./ShoppingListTab";
import { SvgTab } from "./SvgTab";
import { ThreeDTab } from "./ThreeDTab";
import { OrderChecksButton } from "./OrderChecksButton";

const PlacementTab = lazy(() => import("./placement/PlacementTab").then(module => ({ default: module.PlacementTab })));

function TabBody({ tab }: { tab: BoardTab }) {
  switch (tab) {
    case "schematic":
      return <SvgTab kind="schematic" />;
    case "pcb":
      return <SvgTab kind="pcb" />;
    case "placement":
      return <Suspense fallback={<div className="p-6 text-sm text-muted">Opening placement workspace…</div>}><PlacementTab /></Suspense>;
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
    case "notes":
      return <NotesTab />;
    case "files":
      return <FilesTab />;
    case "art":
      return <ArtTab />;
    case "bom":
      return <ShoppingListTab />;
    case "diff":
      return <DiffTab />;
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
      </div>
      <div className="fd-board-controls flex shrink-0 items-center px-3">
        <Tabs
          className="fd-board-tabs min-w-0 flex-1"
          variant="underline"
          tabs={BOARD_TABS.map((id, i) => ({ id, label: BOARD_TAB_LABELS[id], ...(i < 9 ? { hint: `${mod} + ${i + 1}` } : {}) }))}
          value={tab}
          onChange={setBoardTab}
        />
        <BoardViewMenu value={tab} onChange={setBoardTab} modifier={mod} />
      </div>
      <div className="fd-board-stage min-h-0 flex-1">
        <TabBody tab={tab} />
      </div>
    </div>
  );
}
