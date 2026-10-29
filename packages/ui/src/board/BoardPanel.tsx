import { BoardViewTabs } from "./BoardViewTabs";
import { CanvasToolButton } from "../components/CanvasToolButton";
import { HostedReviewTools } from "./HostedReviewTools";
import { WorkspaceMenu } from "../layout/WorkspaceMenu";
import { Icon } from "../components/Icon";
import { BoardComparison } from "./BoardComparison";
import { Button } from "../components/ui";
import { ReviewUpdates } from "./ReviewUpdates";
import { OutputsLibrary } from "./OutputsLibrary";
import { Tabs } from "../components/ui";
import { BoardViewMenu } from "./BoardViewMenu";
import { CircuitLogo } from "../components/CircuitLogo";
import { workspaceViews } from "@fabdesk/client-core";
import { useCore } from "@fabdesk/client-core";
import { useBoardSources, useProjectOrder, useProjects } from "@fabdesk/client-core";
import { BOARD_TABS, BOARD_TAB_LABELS, useUiStore, type BoardTab } from "../stores/ui";
import { modKey } from "../util";
import { CadTab } from "./CadTab";
import { CinemaTab } from "./cinema/CinemaTab";
import { DrcTab } from "./DrcTab";
import { ArtTab } from "./ArtTab";
import { FilesTab } from "./FilesTab";
import { NotesTab } from "./NotesTab";
import { RendersTab } from "./RendersTab";
import { ReviewComments } from "./ReviewComments";
import { DiffTab } from "./DiffTab";
import { ShoppingListTab } from "./ShoppingListTab";
import { SvgTab } from "./SvgTab";
import { ThreeDTab } from "./ThreeDTab";
import { OrderChecksButton } from "./OrderChecksButton";

function TabBody({ tab }: { tab: BoardTab }) {
  switch (tab) {
    case "updates":
      return <ReviewUpdates />;
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
    case "notes":
      return <NotesTab />;
    case "files":
      return <FilesTab />;
    case "art":
      return <ArtTab />;
    case "bom":
      return <ShoppingListTab />;
    case "comments":
      return <ReviewComments />;
    case "diff":
      return <DiffTab />;
    default:
      return null;
  }
}

export function BoardPanel({ canvas = false }: { canvas?: boolean }) {
  const { host } = useCore();
  const area = useUiStore((s) => s.workspaceArea);
  const setWorkspaceTab = useUiStore((s) => s.setWorkspaceTab);
  const tab = useUiStore((s) => s.boardTab);
  const setBoardTab = useUiStore((s) => s.setBoardTab);
  const projectId = useUiStore((s) => s.activeProjectId);
  const compare = useUiStore(s => !!s.activeProjectId && s.boardComparisonByProject[s.activeProjectId] === true);
  const compareAvailable = area === "boards" && (tab === "pcb" || tab === "schematic");
  const setOrderFlowOpen = useUiStore((s) => s.setOrderFlowOpen);
  const order = useProjectOrder(projectId);
  const sources = useBoardSources(projectId);
  const openChecks = () => { if (projectId && useUiStore.getState().activeProjectId === projectId) setBoardTab("drc"); };
  const assembly = sources.data?.mode === "assembly";
  const openOrder = () => {
    if (!projectId || useUiStore.getState().activeProjectId !== projectId) return;
    if (sources.data?.mode !== "single" || sources.isError || sources.isFetching) openChecks();
    else setOrderFlowOpen(true);
  };
  const projects = useProjects();
  const project = projects.data?.find((item) => item.id === projectId);
  const mod = modKey(host.platform);
  const visibleTabs = workspaceViews(area)
    .filter(item => area !== "boards" || item.tab !== "cinema" && item.tab !== "art")
    .map(item => ({
      id: item.tab,
      label: item.label,
    }));
  if (canvas) return <div className="fd-canvas-board" data-testid="board-panel">
    <div className="fd-canvas-controls">
      {area === "boards" ? <BoardViewTabs value={tab} onChange={setWorkspaceTab} /> : workspaceViews(area).length > 1 && <Tabs tabs={visibleTabs} value={tab} onChange={setWorkspaceTab} />}
      {area === "boards" && <WorkspaceMenu className="fd-board-tools fd-canvas-tool-menu" label={<><span aria-label="More board tools"><Icon name="more" width={18} height={18} /></span><span className="fd-canvas-tool-label" aria-hidden="true">More board tools</span></>}><div className="fd-menu-caption">Board tools</div><button aria-current={tab === "art" ? "page" : undefined} onClick={() => setWorkspaceTab("art")}>Artwork</button>{order.data && <button onClick={openOrder}>Order options</button>}</WorkspaceMenu>}
      {area === "review" && tab === "diff" && projectId && <HostedReviewTools key={projectId} projectId={projectId} />}
      {compareAvailable && <CanvasToolButton label={compare ? "Close comparison" : `Show ${tab === "pcb" ? "schematic" : "PCB"} alongside`} icon="panel" active={compare} onClick={() => useUiStore.getState().setBoardComparison(!compare)} />}
      {area === "boards" && <div className="fd-board-task-actions"><Button size="sm" className="fd-routing-task" variant={tab === "cinema" ? "primary" : "ghost"} aria-current={tab === "cinema" ? "page" : undefined} onClick={() => setWorkspaceTab("cinema")}><Icon name="route" width={18} height={18} />Routing</Button><Button size="sm" onClick={openChecks}><Icon name="checkCircle" width={18} height={18} />Checks</Button></div>}
    </div>
    <div className="fd-canvas-board-body">{compareAvailable && compare && projectId ? <BoardComparison key={projectId} projectId={projectId} active={tab as "pcb" | "schematic"} /> : area === "outputs" && tab === "renders" ? <OutputsLibrary key={projectId} projectId={projectId} /> : area === "outputs" && tab === "files" ? <FilesTab key={projectId} exportFocus /> : <TabBody key={`${projectId}:${tab}`} tab={tab} />}</div>
  </div>;
  return (
    <div className="fd-board-panel flex h-full min-w-0 flex-col bg-panel" data-testid="board-panel">
      <div className="fd-board-heading">
        <span className="fd-board-mark"><CircuitLogo width={22} height={22} viewBox="6 6 40 40" /></span>
        <div className="min-w-0 flex-1">
          <div className="fd-board-eyebrow">Board workspace</div>
          <div className="fd-board-title truncate" title={project?.name}>{project?.name ?? "Select a project"}</div>
        </div>
        <div className="fd-board-actions">
          {assembly ? <Button size="sm" onClick={openChecks}>Board checks</Button> : order.data && (order.data.hasKicadPcb || order.data.hasRouted || order.data.ready) && (
            <OrderChecksButton
              order={order.data}
              unavailable={order.isError || sources.isError || sources.isFetching || sources.data?.mode !== "single"}
              onClick={openOrder}
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
        <TabBody key={`${projectId}:${tab}`} tab={tab} />
      </div>
    </div>
  );
}
