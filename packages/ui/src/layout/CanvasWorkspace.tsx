import { HostedReviewTools } from "../board/HostedReviewTools";
import { useEffect, useState } from "react";
import { projectSketchImagePaths, useCore, useBoardSources, useProject, useProjects, useThreads, WORKSPACE_AREAS, type WorkspaceArea } from "@fabdesk/client-core";
import { BoardPanel } from "../board/BoardPanel";
import { ThreadView } from "../chat/ThreadView";
import { ProjectPickerDialog } from "../chat/ProjectPickerDialog";
import { ThreadSidebar } from "../sidebar/ThreadSidebar";
import { CreateProjectDialog } from "../sidebar/CreateProjectDialog";
import { ProjectActionDialog, type ProjectAction } from "../sidebar/ProjectActionDialog";
import { InventoryView } from "../inventory/InventoryView";
import { OpenSourceView } from "../opensource/OpenSourceView";
import { OrderFlow } from "../order/OrderFlow";
import { Button, Dialog, EmptyState, IconButton } from "../components/ui";
import { Icon } from "../components/Icon";
import { FabPlaneLogo } from "../components/FabPlaneLogo";
import { UpdateBadge } from "../components/UpdateBadge";
import { WhatsNewLink } from "../whatsnew/WhatsNew";
import { newChatDraftKey, useUiStore } from "../stores/ui";
import { WorkspaceMenu } from "./WorkspaceMenu";
import { LiveAssemblyPreviews } from "./LiveAssemblyPreviews";
import { ProjectOverview } from "./ProjectOverview";
import { SketchStartReference } from "./SketchStartReference";
import type { AppShellProps } from "./AppShell";
import "./canvas-workspace.css";
import "./canvas-v6.css";


export function CanvasWorkspace({ onNewChat, coreStatus, banner }: AppShellProps) {
  const { host, sseStatus, client } = useCore();
  const projectId = useUiStore((s) => s.activeProjectId);
  const project = useProject(projectId);
  const boardSources = useBoardSources(projectId);
  useEffect(() => {
    const state = useUiStore.getState();
    if (!projectId || state.activeProjectId !== projectId || state.workspaceByProject[projectId] || !project.data || project.isFetching || project.isError || !boardSources.data || boardSources.isFetching || boardSources.isError) return;
    // Choose once from the imported/saved sources. Recording even the empty default
    // prevents later agent writes from stealing the user's current task.
    if (boardSources.data.mode === "assembly") state.setWorkspaceArea("overview");
    else if (!project.data.files.some(file => file.path === "board.kicad_pcb") && project.data.files.some(file => file.path === "board.kicad_sch")) state.setBoardTab("schematic");
    else state.setWorkspaceArea("boards");
  }, [projectId, boardSources.data, boardSources.isFetching, boardSources.isError, project.data, project.isFetching, project.isError]);
  const projects = useProjects();
  const area = useUiStore((s) => s.workspaceArea);
  const boardTab = useUiStore((s) => s.boardTab);
  const areaLabel = area === "boards" && boardSources.data?.mode === "assembly" ? "Boards" : WORKSPACE_AREAS[area].label;
  const openArea = useUiStore((s) => s.setWorkspaceArea);
  const assistantOpen = useUiStore((s) => s.assistantOpen);
  const setAssistantOpen = useUiStore((s) => s.setAssistantOpen);
  const closeAssistant = () => {
    setAssistantOpen(false);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>("[data-assistant-launcher]")?.focus());
  };
  const navigationOpen = useUiStore((s) => s.canvasNavigationOpen);
  const setNavigationOpen = useUiStore((s) => s.setCanvasNavigationOpen);
  const boardOpen = useUiStore((s) => s.boardOpen);
  const sourceId = useUiStore((s) => s.activeOpenSourceId);
  const inventory = useUiStore((s) => s.inventoryOpen);
  const order = useUiStore((s) => s.orderFlowOpen);
  const threadId = useUiStore((s) => s.activeThreadId);
  const threads = useThreads({ ...(projectId ? { projectId } : {}) });
  const [creating, setCreating] = useState<"create" | "github" | null>(null);
  const [projectAction, setProjectAction] = useState<ProjectAction | null>(null);
  const ui = () => useUiStore.getState();
  const name = project.data?.name ?? projects.data?.find((item) => item.id === projectId)?.name ?? (projectId ? "Untitled project" : "New project");
  const conversationOnly = !boardOpen || (!projectId && !!threadId);
  const hasNativeDesign = project.data?.files.some((file) => file.path === "board.kicad_pcb" || file.path === "board.kicad_sch");
  const fresh = !threadId && !sourceId && !inventory && !order && (!projectId || (!!project.data && !boardSources.isError && boardSources.data?.mode === "single" && !hasNativeDesign && area === "boards" && boardTab === "pcb"));
  const sketchPaths = projectSketchImagePaths(project.data?.files ?? []);
  const draftAttachments = useUiStore(s => s.attachments[s.activeThreadId ?? newChatDraftKey(projectId)]);
  const attachedSketch = draftAttachments?.slice().reverse().find(item => sketchPaths.includes(item.path))?.path;
  const referenceCanvas = !!projectId && !!project.data && !hasNativeDesign && !boardSources.isError && boardSources.data?.mode === "single" && (area === "overview" || area === "boards" && boardTab === "pcb") && boardOpen;
  const sketchReference = referenceCanvas ? attachedSketch ?? sketchPaths[0] : undefined;
  const referenceStart = fresh && !!sketchReference;
  const secondary = !!sourceId || inventory || order;
  const showAssistant = !fresh && !conversationOnly && !secondary;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(client.baseUrl).hostname);
  const connected = sseStatus === "open" && (coreStatus?.state ?? "ready") === "ready";

  return <div className="fd-canvas-workspace flex h-full min-w-0 flex-col" data-testid="canvas-workspace">
    <header className="fd-canvas-header" style={{ paddingLeft: host.platform === "darwin" ? 84 : undefined, WebkitAppRegion: "drag" } as React.CSSProperties}>
      <button className="fd-canvas-brand" title="Project overview" onClick={() => projectId ? openArea("overview") : ui().setActiveThread(null)}>
        <FabPlaneLogo /><span>fabPlane</span>
      </button>
      <WorkspaceMenu className="fd-project-switcher" label={<><span>{name}</span><Icon name="chevronDown" width={15} height={15} /></>}>
        {projectId && <><div className="fd-menu-caption">Current project</div><button onClick={() => setProjectAction({ id: projectId, name, action: "rename" })}><Icon name="compose" width={16} height={16} />Rename project</button><div className="fd-menu-divider" /></>}
        <div className="fd-menu-caption">Recent projects</div>
        {projects.isError && <button onClick={() => void projects.refetch()}>Could not load projects · Retry</button>}
        {projects.isPending && <p className="p-3 text-xs text-muted">Loading projects…</p>}
        {(projects.data ?? []).filter(item => item.id !== projectId).slice(0, 5).map((item) => <button key={item.id} aria-current={item.id === projectId ? "true" : undefined} onClick={() => { ui().setActiveProject(item.id); ui().setBoardOpen(true); }}><Icon name="folder" width={16} height={16} /><span>{item.name}</span>{item.id === projectId && <Icon name="check" width={15} height={15} />}</button>)}
        <div className="fd-menu-divider" />
        <button onClick={() => setCreating("create")}><Icon name="plus" width={16} height={16} />New project</button>
        <button onClick={() => setCreating("github")}><Icon name="folderOpen" width={16} height={16} />Import from GitHub</button>
        <button onClick={() => setNavigationOpen(true)}><Icon name="sidebar" width={16} height={16} />Browse projects & chats</button>
      </WorkspaceMenu>
      {referenceStart && <span className="fd-canvas-breadcrumb"><span>/</span><strong>Start with sketch</strong></span>}
      <div className="fd-canvas-header-actions">
        <span className="fd-canvas-connection" title={coreStatus?.message ?? `Core ${coreStatus?.state ?? "ready"}; events ${sseStatus}`}><i data-connected={connected} />{connected ? local ? "Local workspace" : "Remote workspace" : "Reconnecting…"}</span>
        {projectId && !fresh && <Button size="sm" variant="ghost" title="Review source and output updates" aria-current={area === "review" && boardTab === "updates" ? "page" : undefined} onClick={() => ui().setBoardTab("updates")}>Review</Button>}
        {projectId && !fresh && <HostedReviewTools key={projectId} projectId={projectId} shareButton />}
        <WorkspaceMenu className="fd-workspace-overflow" label={<span aria-label="Workspace options"><Icon name="more" width={20} height={20} /></span>}>
          {fresh && projectId && <><div className="fd-menu-caption">Project tools</div>{(Object.keys(WORKSPACE_AREAS) as WorkspaceArea[]).map(key => <button key={key} onClick={() => openArea(key)}>{WORKSPACE_AREAS[key].label}</button>)}<div className="fd-menu-divider" /></>}
          <button onClick={() => ui().setPaletteOpen(true)}><Icon name="search" width={16} height={16} />Search commands</button>
          <button onClick={() => ui().setSettingsOpen(true)}><Icon name="settings" width={16} height={16} />Settings</button>
          <button onClick={() => ui().setInventoryOpen(true)}><Icon name="library" width={16} height={16} />Parts inventory</button>
          <button onClick={() => { ui().setBoardOpen(!boardOpen); setAssistantOpen(false); }}>{boardOpen ? "Focus conversation" : "Return to canvas"}</button>
          <button onClick={() => ui().setCanvasMode(false)}>Use classic layout</button>
          <div className="fd-menu-divider" /><div className="fd-workspace-update-actions"><WhatsNewLink /><UpdateBadge /></div>
        </WorkspaceMenu>
      </div>
    </header>
    {banner}
    {projectId && boardSources.data?.mode === "assembly" && <LiveAssemblyPreviews key={`${client.baseUrl}/${projectId}/${boardSources.data.manifestSha256}`} projectId={projectId} data={boardSources.data} enabled={!boardSources.isFetching && !boardSources.isError && connected && boardSources.data.editing === "explicit-source-tools"} />}
    <main className="fd-canvas-main" data-task-toolbar={!!projectId && !fresh && !secondary && !conversationOnly} data-area={fresh ? "start" : area}>
      {projectId && !fresh && !secondary && !conversationOnly && <nav className="fd-canvas-destinations" aria-label="Project workspace">
        <WorkspaceMenu label={<><Icon name="library" width={16} height={16} /><span>{areaLabel}</span><Icon name="chevronDown" width={14} height={14} /></>}>
          <div className="fd-menu-caption">Project workspace</div>
          {(Object.keys(WORKSPACE_AREAS) as WorkspaceArea[]).map((key) => <button key={key} aria-current={area === key ? "page" : undefined} onClick={() => openArea(key)}>{key === "boards" && boardSources.data?.mode === "assembly" ? "Boards" : WORKSPACE_AREAS[key].label}</button>)}
        </WorkspaceMenu>
      </nav>}
      {sketchReference && !fresh && !secondary && !conversationOnly && <span className="fd-reference-view-label">Project reference</span>}
      {secondary && <Button className="fd-canvas-back" size="sm" onClick={() => { ui().setActiveOpenSourceId(null); ui().setInventoryOpen(false); ui().setOrderFlowOpen(false); ui().setBoardOpen(true); }}>← Return to canvas</Button>}
      <div className="fd-canvas-surface">
        {order ? <OrderFlow /> : inventory ? <InventoryView /> : sourceId ? <OpenSourceView /> : projectId && boardSources.isError && !conversationOnly && (area === "boards" || area === "overview") ? <EmptyState title="Could not verify project board sources" action={<><Button onClick={() => void boardSources.refetch()}>Try again</Button><Button variant="ghost" onClick={() => ui().setBoardTab("files")}>Open project files</Button></>}><p role="alert">Review the project files or retry the source check before opening a board.</p>{boardSources.error instanceof Error && <details className="mt-3 max-w-xl text-left"><summary>Source check details</summary><p className="mt-2 break-words">{boardSources.error.message}</p></details>}</EmptyState> : projectId && sketchReference && !conversationOnly ? <SketchStartReference key={projectId} projectId={projectId} paths={sketchPaths} preferred={sketchReference} checking={project.isFetching} failed={project.isError} conversation={!!threadId || area === "overview"} assistantOpen={assistantOpen} attached={attachedSketch} /> : fresh || conversationOnly ? null : area === "overview" || area === "boards" && boardSources.data?.mode === "assembly" ? <ProjectOverview key={projectId} boardPicker={area === "boards"} /> : <BoardPanel canvas />}
      </div>
        <section className={referenceStart ? "fd-canvas-reference-composer" : fresh ? "fd-canvas-start-surface" : conversationOnly ? "fd-canvas-conversation-surface" : "fd-assistant-dock"} aria-label="fabPlane assistant" hidden={secondary || (!fresh && !conversationOnly && !assistantOpen)} onKeyDown={(event) => {
          if (!fresh && !conversationOnly && event.key === "Escape" && !(event.target as HTMLElement).closest("details[open]")) { event.stopPropagation(); closeAssistant(); }
        }}>
          {!fresh && !conversationOnly && <div className="fd-assistant-heading"><span><Icon name="sparkles" width={17} height={17} />Ask fabPlane</span><div>
            <WorkspaceMenu label={<span aria-label="Project conversations"><Icon name="chevronDown" width={16} height={16} /></span>}>
              <div className="fd-menu-caption">Project conversations</div>
              {(threads.data ?? []).filter((t) => t.projectId === projectId && !t.archived).map((t) => <button key={t.id} onClick={() => ui().setActiveThread(t.id)}>{t.title || "Untitled conversation"}</button>)}
              <button onClick={onNewChat}><Icon name="plus" width={16} height={16} />New conversation</button>
            </WorkspaceMenu>
            <IconButton size="sm" title="Close assistant" onClick={closeAssistant}><Icon name="close" width={17} height={17} /></IconButton>
          </div></div>}
          <ThreadView presentation={fresh ? "start" : "chat"} referenceStart={referenceStart} />
        </section>
        {showAssistant && !assistantOpen && <button className="fd-ask-fabdesk" data-assistant-launcher onClick={() => { setAssistantOpen(true); ui().focusComposer(); }}><Icon name="sparkles" width={19} height={19} /><span>Ask fabPlane</span><Icon name="mic" width={19} height={19} /></button>}
      {fresh && <div className="fd-canvas-start-note">Your ideas and files stay with your project</div>}
    </main>
    <Dialog open={navigationOpen} onClose={() => setNavigationOpen(false)} bare ariaLabel="Projects and conversations" className="fd-canvas-drawer">
      <div className="fd-canvas-drawer-inner"><div className="fd-assistant-heading"><span>Projects & conversations</span><IconButton size="sm" title="Close navigation" onClick={() => setNavigationOpen(false)}><Icon name="close" width={17} height={17} /></IconButton></div>
      <ThreadSidebar onNewChat={onNewChat} /></div>
    </Dialog>
    {creating && <CreateProjectDialog initialMode={creating} onClose={() => setCreating(null)} onCreated={(id) => { ui().setActiveProject(id); ui().setBoardOpen(true); setCreating(null); }} />}
    {projectAction && <ProjectActionDialog key={projectAction.id} project={projectAction} onClose={() => setProjectAction(null)} />}
    <ProjectPickerDialog />
  </div>;
}
