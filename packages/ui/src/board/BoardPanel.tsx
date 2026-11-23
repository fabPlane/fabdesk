import { useState, lazy, Suspense } from "react";
import { BoardChecksDialog } from "./BoardChecksDialog";
import { ImportedBoardIdentity } from "./ImportedBoardIdentity";
import { AssemblyBoardPicker } from "./AssemblyBoardPicker";
import { restoreAssemblySelection, useCore, useProjectOrder, useProjects, workspaceViews, useBoardSources } from "@fabdesk/client-core";
import { BoardViewTabs } from "./BoardViewTabs";
import { CanvasToolButton } from "../components/CanvasToolButton";
import { HostedReviewTools } from "./HostedReviewTools";
import { WorkspaceMenu } from "../layout/WorkspaceMenu";
import { Icon } from "../components/Icon";
import { BoardComparison } from "./BoardComparison";
import { Button, Tabs } from "../components/ui";
import { ReviewUpdates } from "./ReviewUpdates";
import { OutputsLibrary } from "./OutputsLibrary";
import { BoardViewMenu } from "./BoardViewMenu";
import { CircuitLogo } from "../components/CircuitLogo";
import { BOARD_TABS, BOARD_TAB_LABELS, useUiStore, type BoardTab } from "../stores/ui";
import { BoardMaterialSettings } from "./BoardMaterialSettings";
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

const PlacementTab = lazy(() => import("./placement/PlacementTab").then(module => ({ default: module.PlacementTab })));

function TabBody({ tab, canvas = false, onOpenChecks }: { tab: BoardTab; canvas?: boolean; onOpenChecks?: () => void }) {
  switch (tab) {
    case "updates":
      return <ReviewUpdates />;
    case "schematic":
      return <SvgTab kind="schematic" {...(onOpenChecks ? { onOpenChecks } : {})} />;
    case "pcb":
      return <SvgTab kind="pcb" {...(onOpenChecks ? { onOpenChecks } : {})} />;
    case "placement":
      return <Suspense fallback={<div className="p-6 text-sm text-muted">Opening placement workspace…</div>}><PlacementTab canvas={canvas} /></Suspense>;
    case "cinema":
      return <CinemaTab canvas={canvas} {...(onOpenChecks ? { onOpenChecks } : {})} />;
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
  const compareAvailable = area === "boards" && (tab === "pcb" || tab === "schematic" || tab === "3d");
  const setOrderFlowOpen = useUiStore((s) => s.setOrderFlowOpen);
  const order = useProjectOrder(projectId);
  const sources = useBoardSources(projectId);
  const [checksOpen, setChecksOpen] = useState(false);
  const openChecks = () => { if (projectId && useUiStore.getState().activeProjectId === projectId) canvas && area === "boards" ? setChecksOpen(true) : setBoardTab("drc"); };
  const assembly = sources.data?.mode === "assembly";
  const savedSelection = useUiStore(state => projectId ? state.assemblyBoardByProject[projectId] : undefined);
  const selected = sources.data?.mode === "assembly" ? restoreAssemblySelection(sources.data, savedSelection) : null;
  const openOrder = () => {
    if (!projectId || useUiStore.getState().activeProjectId !== projectId) return;
    if (sources.data?.mode !== "single" || sources.isError || sources.isFetching) openChecks();
    else setOrderFlowOpen(true);
  };
  const projects = useProjects();
  const project = projects.data?.find((item) => item.id === projectId);
  const mod = modKey(host.platform);
  const visibleTabs = workspaceViews(area)
    .filter(item => area !== "boards" || item.tab !== "cinema" && item.tab !== "art" && item.tab !== "placement")
    .map(item => ({
      id: item.tab,
      label: item.label,
    }));
  if (canvas) return <div className="fd-canvas-board" data-testid="board-panel">
    <div className="fd-canvas-controls">
      {area === "boards" && projectId && sources.data?.mode === "single" && <ImportedBoardIdentity projectId={projectId} />}
      {area === "boards" && tab === "placement" && projectId && sources.data?.mode === "assembly" && <AssemblyBoardPicker projectId={projectId} data={sources.data} selection={selected} disabled={sources.isFetching} onChoose={selection => useUiStore.getState().setAssemblyBoard(selection)} onBack={() => useUiStore.getState().setWorkspaceArea("overview")} />}
      {area === "boards" && tab === "cinema" ? <div className="fd-routing-toolbar-slot" data-routing-toolbar-slot /> : area === "boards" ? <BoardViewTabs value={tab === "placement" ? "pcb" : tab} onChange={setWorkspaceTab} /> : workspaceViews(area).length > 1 && <Tabs tabs={visibleTabs} value={tab} onChange={setWorkspaceTab} />}
      {area === "boards" && tab !== "cinema" && tab !== "placement" && <WorkspaceMenu className="fd-board-tools fd-canvas-tool-menu" label={<><span aria-label="More board tools"><Icon name="more" width={18} height={18} /></span><span className="fd-canvas-tool-label" aria-hidden="true">More board tools</span></>}><div className="fd-menu-caption">Board tools</div><button onClick={() => setWorkspaceTab("placement")}>Edit placement</button><button aria-current={tab === "art" ? "page" : undefined} onClick={() => setWorkspaceTab("art")}>Artwork</button>{order.data && <button onClick={openOrder}>Order options</button>}</WorkspaceMenu>}
      {area === "boards" && tab === "placement" && <div className="fd-placement-toolbar-slot" data-placement-toolbar-slot />}
      {area === "mechanical" && <div className="fd-mechanical-toolbar-slot" data-mechanical-toolbar-slot />}
      {area === "review" && tab === "diff" && projectId && <HostedReviewTools key={projectId} projectId={projectId} />}
      {area === "review" && (tab === "updates" || tab === "diff" || tab === "comments") && <div className="fd-review-scope-slot" data-review-scope-slot />}
      {compareAvailable && <CanvasToolButton label={compare ? "Close all views" : "Show all three views"} icon="panel" active={compare} onClick={() => useUiStore.getState().setBoardComparison(!compare)} />}
      {area === "boards" && tab !== "cinema" && tab !== "placement" && <div className="fd-board-task-actions">{tab === "pcb" && <Button size="sm" variant="secondary" onClick={() => setWorkspaceTab("placement")}><Icon name="pcb" width={18} height={18} />Edit placement</Button>}<Button size="sm" className="fd-routing-task" variant="secondary" onClick={() => setWorkspaceTab("cinema")}><Icon name="route" width={18} height={18} />Routing</Button><Button size="sm" onClick={openChecks}><Icon name="checkCircle" width={18} height={18} />Checks</Button></div>}
    </div>
    {projectId && <BoardChecksDialog key={projectId} projectId={projectId} open={checksOpen} onClose={() => setChecksOpen(false)} />}
    <div className="fd-canvas-board-body">{compareAvailable && compare && projectId ? <BoardComparison key={projectId} projectId={projectId} active={tab as "pcb" | "schematic" | "3d"} onOpenChecks={openChecks} /> : area === "outputs" && tab === "renders" ? <OutputsLibrary key={projectId} projectId={projectId} /> : area === "outputs" && tab === "files" ? <FilesTab key={projectId} exportFocus /> : <TabBody key={`${projectId}:${tab}`} tab={tab} canvas onOpenChecks={openChecks} />}</div>
  </div>;
  return (
    <div className="fd-board-panel flex h-full min-w-0 flex-col bg-panel" data-testid="board-panel">
      <div className="fd-board-heading">
        <span className="fd-board-mark"><CircuitLogo width={22} height={22} viewBox="6 6 40 40" /></span>
        <div className="min-w-0 flex-1">
          <div className="fd-board-eyebrow">Board workspace</div>
          <div className="fd-board-title truncate" title={project?.name}>{project?.name ?? "Select a project"}</div>
          {projectId && <BoardMaterialSettings projectId={projectId} />}
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
