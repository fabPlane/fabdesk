import { connectionLabel,draftConversation as latestDraftConversation,projectSketchImagePaths,useAuthStore,useBoardSources,useCore,useCoreIdentity,useProject,useProjects,useRunsStore,useThreads,WORKSPACE_AREAS,type WorkspaceArea } from "@fabdesk/client-core";
import type { ProjectDetail } from "@fabdesk/protocol";
import { useEffect,useRef,useState } from "react";
import { ProfileButton } from "../auth/ProfileAccountDialog";
import { BoardPanel } from "../board/BoardPanel";
import { ConnectionsWorkspace } from "../board/ConnectionsWorkspace";
import { HistoryWorkspace } from "../board/HistoryWorkspace";
import { HostedReviewTools } from "../board/HostedReviewTools";
import { ProjectPickerDialog } from "../chat/ProjectPickerDialog";
import { ThreadView } from "../chat/ThreadView";
import { useAssistantSurface } from "../chat/useAssistantSurface";
import { DisclosureSummary } from "../components/DisclosureSummary";
import { FabPlaneLogo } from "../components/FabPlaneLogo";
import { Icon } from "../components/Icon";
import { Button,Dialog,EmptyState,IconButton } from "../components/ui";
import { UpdateBadge } from "../components/UpdateBadge";
import { InventoryView } from "../inventory/InventoryView";
import { OpenSourceView } from "../opensource/OpenSourceView";
import { OrderFlow } from "../order/OrderFlow";
import { CreateProjectDialog } from "../sidebar/CreateProjectDialog";
import { ProjectActionDialog,type ProjectAction } from "../sidebar/ProjectActionDialog";
import { ThreadSidebar } from "../sidebar/ThreadSidebar";
import { newChatDraftKey,useUiStore } from "../stores/ui";
import { WhatsNewLink } from "../whatsnew/WhatsNew";
import type { AppShellProps } from "./AppShell";
import "./canvas-v6.css";
import "./canvas-workspace.css";
import { CreateIdeaProjectDialog } from "./CreateIdeaProjectDialog";
import { ProjectActivity } from "./ProjectActivity";
import { ProjectHome } from "./ProjectHome";
import { ProjectOverview } from "./ProjectOverview";
import { ProjectStatus } from "./ProjectStatus";
import { SketchStartReference } from "./SketchStartReference";
import "./workspace-bars.css";
import { WorkspaceBackButton } from "./WorkspaceBackButton";
import { WorkspaceMenu } from "./WorkspaceMenu";


export function CanvasWorkspace({ onNewChat, coreStatus, banner }: AppShellProps) {
  const { host, sseStatus, client } = useCore();
  const projectId = useUiStore((s) => s.activeProjectId);
  const project = useProject(projectId);
  const projects = useProjects();
  const coreIdentity = useCoreIdentity();
  const isDraft = project.data ? !!project.data.manifest.ideaDraft : !!projects.data?.find(item => item.id === projectId)?.isDraft;
  const [showProjects, setShowProjects] = useState(false);
  const [setupDraft, setSetupDraft] = useState<ProjectDetail | null>(null);
  const [draftView, setDraftView] = useState<"sketch" | "conversation">("sketch");
  const seenRequest = useRef("");
  useEffect(() => { if (!projectId) setShowProjects(false); setDraftView("sketch"); }, [projectId]);
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
  useEffect(() => {
    if (projectId && !coreIdentity.isPending && project.data?.id === projectId && !project.isFetching && !project.isError)
      useUiStore.getState().recordProjectVisit(coreIdentity.data ? `core:${coreIdentity.data}` : client.baseUrl, projectId);
  }, [client.baseUrl, coreIdentity.data, coreIdentity.isPending, projectId, project.data?.id, project.isFetching, project.isError]);
  const area = useUiStore((s) => s.workspaceArea);
  const boardTab = useUiStore((s) => s.boardTab);
  const areaLabel = area === "boards" && boardSources.data?.mode === "assembly" ? "Boards" : WORKSPACE_AREAS[area].label;
  const openArea = useUiStore((s) => s.setWorkspaceArea);
  const assistantOpen = useUiStore((s) => s.assistantOpen);
  const setAssistantOpen = useUiStore((s) => s.setAssistantOpen);
  const focusConversation = () => { ui().setBoardOpen(false); setAssistantOpen(false); };
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
  const sketchPaths = projectSketchImagePaths(project.data?.files ?? []);
  const draftRunning = useRunsStore(s => !!threadId && !!s.runsByThread[threadId]);
  const requestedBuild = project.data?.manifest.ideaDraft?.requestedBuild;
  useEffect(() => {
    const key = `${projectId}:${requestedBuild}`;
    if (isDraft && requestedBuild && !draftRunning && key !== seenRequest.current && project.data) { seenRequest.current = key; setSetupDraft(project.data); }
  }, [isDraft, requestedBuild, draftRunning, projectId, project.data]);
  // Opening a project resumes its latest conversation once, so saved history is not hidden behind
  // the blank start surface. A later "New conversation" in the same project is left alone.
  const resumedProject = useRef<string | null>(null);
  useEffect(() => {
    if (!projectId) { resumedProject.current = null; return; }
    if (resumedProject.current === projectId || !threads.data) return;
    resumedProject.current = projectId;
    if (threadId || sourceId || inventory || order) return;
    const latest = latestDraftConversation(projectId, threads.data);
    if (latest) ui().setActiveThread(latest.id);
  }, [projectId, threads.data, threadId, sourceId, inventory, order]);
  const draftConversation = draftView === "conversation" || !sketchPaths.length;
  const conversationOnly = !boardOpen || (!projectId && !!threadId) || (isDraft && draftConversation);
  const hasNativeDesign = project.data?.files.some((file) => file.path === "board.kicad_pcb" || file.path === "board.kicad_sch");
  const fresh = !(isDraft && sketchPaths.length) && !threadId && !sourceId && !inventory && !order && (!projectId || (!!project.data && !boardSources.isError && boardSources.data?.mode === "single" && !hasNativeDesign && area === "boards" && boardTab === "pcb"));
  const draftAttachments = useUiStore(s => s.attachments[s.activeThreadId ?? newChatDraftKey(projectId)]);
  const attachedSketch = draftAttachments?.slice().reverse().find(item => sketchPaths.includes(item.path))?.path;
  const referenceCanvas = !!projectId && !!project.data && !hasNativeDesign && !boardSources.isError && boardSources.data?.mode === "single" && (area === "overview" || area === "boards" && boardTab === "pcb") && boardOpen;
  const sketchReference = referenceCanvas ? attachedSketch ?? sketchPaths[0] : undefined;
  const referenceStart = fresh && !!sketchReference;
  useAssistantSurface(projectId && (isDraft || fresh || !!sketchReference) ? {
    projectId, label: isDraft ? sketchReference && !conversationOnly ? "Idea draft / Sketch" : "Idea draft / Conversation" : sketchReference ? "Project sketch" : "Project idea", priority: 5,
    details: JSON.stringify({ stage: "Planning before a native board exists", savedReference: sketchReference ?? null, savedSketches: sketchPaths.slice(0, 20), instruction: "Use the actual saved references and project notes. A planning sketch is not a native schematic, PCB, checked circuit or generated board." }),
  } : null);
  const secondary = !!sourceId || inventory || order;
  const showAssistant = !fresh && !conversationOnly;
  const home = !projectId && !threadId && !secondary;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(client.baseUrl).hostname);
  const connected = sseStatus === "open" && (coreStatus?.state ?? "ready") === "ready";
  const authMode = useAuthStore((s) => s.state?.mode);
  const connection = connectionLabel({ connected, localCore: local, authMode });
  const connectionTitle = coreStatus?.message ?? `Core ${coreStatus?.state ?? "ready"}; events ${sseStatus}`;

  const destinations = projectId && !secondary && (!conversationOnly || isDraft) && <nav className="fd-canvas-destinations" aria-label="Project workspace">
    {isDraft ? <><Button size="sm" variant="ghost" aria-pressed={!draftConversation} onClick={() => { setDraftView("sketch"); if (!sketchPaths.length) ui().setSketchOpen(true, "draw"); }}><Icon name="compose" width={16} height={16} />Sketch</Button><Button size="sm" variant="ghost" aria-pressed={draftConversation} onClick={() => { if (!threadId) ui().setActiveThread(latestDraftConversation(projectId, threads.data ?? [])?.id ?? null); setDraftView("conversation"); }}><Icon name="sparkles" width={16} height={16} />Conversation</Button></> : <WorkspaceMenu label={<><Icon name="library" width={16} height={16} /><span>{fresh ? "Start" : areaLabel}</span><Icon name="chevronDown" width={14} height={14} /></>}>
      <div className="fd-menu-caption">Project workspace</div>
      {(Object.keys(WORKSPACE_AREAS) as WorkspaceArea[]).map((key) => <button key={key} aria-current={area === key ? "page" : undefined} onClick={() => openArea(key)}>{key === "boards" && boardSources.data?.mode === "single" && !hasNativeDesign ? "Start" : key === "boards" && boardSources.data?.mode === "assembly" ? "Boards" : WORKSPACE_AREAS[key].label}</button>)}
    </WorkspaceMenu>}
    {fresh && !isDraft && <Button size="sm" variant="ghost" onClick={() => ui().setBoardTab("notes")}><Icon name="compose" width={16} height={16} />Project notes</Button>}
  </nav>;
  const surface = order
    ? <OrderFlow />
    : inventory ? <InventoryView />
    : sourceId ? <OpenSourceView />
    : projectId && boardSources.isError && !conversationOnly && (area === "boards" || area === "overview") ? <EmptyState title="Could not verify project board sources" action={<><Button onClick={() => void boardSources.refetch()}>Try again</Button><Button variant="ghost" onClick={() => ui().setBoardTab("files")}>Open project files</Button></>}><p role="alert">Review the project files or retry the source check before opening a board.</p>{boardSources.error instanceof Error && <details className="mt-3 max-w-xl text-left"><DisclosureSummary icon="warning" label="Source check details" variant="compact" /><p className="mt-2 break-words">{boardSources.error.message}</p></details>}</EmptyState>
    : projectId && area === "status" && !conversationOnly ? <ProjectStatus key={projectId} />
    : projectId && sketchReference && !conversationOnly ? <SketchStartReference key={projectId} projectId={projectId} paths={sketchPaths} preferred={sketchReference} checking={project.isFetching} failed={project.isError} conversation={isDraft || !!threadId || area === "overview"} assistantOpen={assistantOpen} attached={attachedSketch} />
    : fresh || conversationOnly ? null
    : projectId && area === "connections" ? <ConnectionsWorkspace key={projectId} projectId={projectId} />
    : projectId && area === "history" ? <HistoryWorkspace key={projectId} projectId={projectId} />
    : area === "overview" || area === "boards" && boardSources.data?.mode === "assembly" && boardTab !== "cinema" && boardTab !== "placement" ? <ProjectOverview key={projectId} boardPicker={area === "boards"} />
    : undefined;
  const inlineBoardNavigation = area === "boards" && surface === undefined && !isDraft;

  return <div className="fd-canvas-workspace flex h-full min-w-0 flex-col" data-testid="canvas-workspace">
    <header className="fd-canvas-header" style={{
      paddingLeft: host.platform === "darwin" ? 84 : undefined,
      // Unlike the classic toolbar, this header follows page zoom. The overlay
      // environment values already use its CSS pixels; do not scale them again.
      paddingRight: "calc(var(--fd-canvas-gutter, 24px) + max(0px, 100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw)))",
      WebkitAppRegion: "drag",
    } as React.CSSProperties}>
      <button className="fd-canvas-brand" title="Project overview" onClick={() => { if (projectId) openArea("overview"); else { ui().setActiveThread(null); setShowProjects(false); } }}>
        <FabPlaneLogo /><span>fabPlane</span>
      </button>
      {projectId ? <><WorkspaceBackButton /><strong className="fd-project-identity" title={name}>{name}</strong><Button className="fd-header-home" size="sm" variant="ghost" onClick={() => ui().requestProjectClose(true)} title="Close project and return to Home">Home</Button></> : <span className="fd-home-header-label">{showProjects ? "Projects" : "Home"}</span>}
      {isDraft && <span className="fd-idea-badge">Draft</span>}
      {referenceStart && <span className="fd-canvas-breadcrumb"><span>/</span><strong>Start with sketch</strong></span>}
      <div className="fd-canvas-header-actions">
        {home && !showProjects && <Button size="sm" onClick={() => setCreating("create")}><Icon name="plus" width={16} height={16} />New project</Button>}
        {home && <Button size="sm" onClick={() => setShowProjects(!showProjects)}><Icon name={showProjects ? "chevronLeft" : "folder"} width={16} height={16} />{showProjects ? "Home" : "Projects"}</Button>}
        {projectId && !boardOpen && !secondary && !isDraft && <Button size="sm" title="Return to the canvas workspace" onClick={() => { ui().setBoardOpen(true); setAssistantOpen(false); }}><Icon name="pcb" width={16} height={16} />Canvas</Button>}
        {projectId && <ProjectActivity key={`${client.baseUrl}/${projectId}`} projectId={projectId} />}
        <span className="fd-canvas-connection" title={connectionTitle}><i data-connected={connected} />{connection ?? <span className="sr-only">Connected</span>}</span>
        <span className="fd-canvas-update"><UpdateBadge /></span>
        {projectId && !fresh && !isDraft && <Button size="sm" variant="secondary" title="Review source and output updates" aria-current={area === "review" && boardTab === "updates" ? "page" : undefined} onClick={() => ui().setBoardTab("updates")}>Review</Button>}
        {projectId && !fresh && !isDraft && <HostedReviewTools key={projectId} projectId={projectId} shareButton />}
        <ProfileButton />
        <WorkspaceMenu className="fd-workspace-overflow" label={<span aria-label="Workspace options"><Icon name="more" width={20} height={20} /></span>}>
          {projectId && <><div className="fd-menu-caption">Current project</div><button onClick={() => setProjectAction({ id: projectId, name, action: "rename", isDraft })}><Icon name="compose" width={16} height={16} />{isDraft ? "Rename idea" : "Rename project"}</button><button onClick={() => ui().requestProjectClose(true)}><Icon name="close" width={16} height={16} />Close project · Home</button><button onClick={() => setNavigationOpen(true)}><Icon name="sidebar" width={16} height={16} />Project conversations</button><div className="fd-menu-divider" /></>}
          <button onClick={() => ui().setPaletteOpen(true)}><Icon name="search" width={16} height={16} />Search commands</button>
          <button onClick={() => ui().setSettingsOpen(true)}><Icon name="settings" width={16} height={16} />Settings</button>
          <button onClick={() => ui().setInventoryOpen(true)}><Icon name="library" width={16} height={16} />Parts inventory</button>
          {projectId && <button onClick={() => { ui().setBoardOpen(!boardOpen); setAssistantOpen(false); }}>{boardOpen ? "Focus conversation" : "Return to canvas"}</button>}
          <button onClick={() => ui().setCanvasMode(false)}>Use classic layout</button>
          <div className="fd-menu-divider" /><div className="fd-workspace-update-actions"><WhatsNewLink /></div>
        </WorkspaceMenu>
      </div>
    </header>
    {banner}
    {home ? <main className="fd-home-surface"><ProjectHome listing={showProjects} onViewProjects={() => setShowProjects(true)} onCreate={() => setCreating("create")} onImport={() => setCreating("github")} onBrowse={() => { ui().setSidebarListTab("open_source"); setNavigationOpen(true); }} /></main> : <main className="fd-canvas-main" data-draft-view={isDraft && !secondary ? conversationOnly ? "conversation" : "sketch" : undefined} data-task-toolbar={!!projectId && !secondary && (!conversationOnly || isDraft)} data-area={fresh ? "start" : area}>
      {!inlineBoardNavigation && destinations}
      {sketchReference && !isDraft && !fresh && !secondary && !conversationOnly && <span className="fd-reference-view-label">Project reference</span>}
      {secondary && !order && <Button className="fd-canvas-back" size="sm" onClick={() => { ui().setActiveOpenSourceId(null); ui().setInventoryOpen(false); ui().setOrderFlowOpen(false); ui().setBoardOpen(true); }}>← Return to canvas</Button>}
      <div className="fd-canvas-surface">
        {surface !== undefined ? surface : <BoardPanel canvas navigation={inlineBoardNavigation ? destinations : null} />}
      </div>
        <section className={referenceStart ? "fd-canvas-reference-composer" : fresh ? "fd-canvas-start-surface" : conversationOnly ? "fd-canvas-conversation-surface" : "fd-assistant-dock"} aria-label="fabPlane assistant" hidden={!fresh && !conversationOnly && !assistantOpen} onKeyDown={(event) => {
          if (!fresh && !conversationOnly && event.key === "Escape" && !(event.target as HTMLElement).closest("details[open]")) { event.stopPropagation(); closeAssistant(); }
        }}>
          {!fresh && !conversationOnly && <div className="fd-assistant-heading"><span><Icon name="sparkles" width={17} height={17} />Ask fabPlane</span><div>
            <WorkspaceMenu label={<span aria-label="Project conversations"><Icon name="sidebar" width={16} height={16} /></span>}>
              <div className="fd-menu-caption">Project conversations</div>
              {(threads.data ?? []).filter((t) => t.projectId === projectId && !t.archived).map((t) => <button key={t.id} onClick={() => ui().setActiveThread(t.id)}>{t.title || "Untitled conversation"}</button>)}
              <button onClick={onNewChat}><Icon name="plus" width={16} height={16} />New conversation</button>
            </WorkspaceMenu>
            <IconButton size="sm" title="Expand conversation to full size" onClick={focusConversation}><Icon name="expand" width={16} height={16} /></IconButton>
            <IconButton size="sm" title="Minimize assistant" onClick={closeAssistant}><Icon name="minus" width={17} height={17} /></IconButton>
          </div></div>}
          <ThreadView presentation={fresh ? "start" : "chat"} referenceStart={referenceStart} />
        </section>
        {showAssistant && !assistantOpen && <button className="fd-ask-fabdesk" aria-label="Ask fabPlane" data-assistant-launcher onClick={() => { setAssistantOpen(true); ui().focusComposer(); }}><Icon name="sparkles" width={19} height={19} /><span>Ask fabPlane</span><Icon name="mic" width={19} height={19} /></button>}
      {isDraft ? <div className="fd-draft-build-strip"><span><Icon name="compose" width={16} height={16} />Idea draft · No engineering files yet</span><Button variant="primary" disabled={draftRunning} onClick={() => { if (project.data) setSetupDraft(project.data); }}>{draftRunning ? "Reply in progress…" : "Create a project"}</Button></div> : fresh && <div className="fd-canvas-start-note">Your ideas and files stay with your project</div>}
    </main>}
    <Dialog open={navigationOpen} onClose={() => setNavigationOpen(false)} bare ariaLabel={projectId ? "Project conversations" : "Projects and conversations"} className="fd-canvas-drawer">
      <div className="fd-canvas-drawer-inner"><div className="fd-assistant-heading"><span>{projectId ? "Project conversations" : "Projects & conversations"}</span><IconButton size="sm" title="Close navigation" onClick={() => setNavigationOpen(false)}><Icon name="close" width={17} height={17} /></IconButton></div>
      <ThreadSidebar projectOnly={!!projectId} onNewChat={onNewChat} onOpenProject={(id) => { ui().setActiveProject(id); ui().setBoardOpen(true); setNavigationOpen(false); }} /></div>
    </Dialog>
    {creating && <CreateProjectDialog initialMode={creating} onClose={() => setCreating(null)} onCreated={(id) => { ui().setActiveProject(id); ui().setBoardOpen(true); setCreating(null); }} />}
    {setupDraft && <CreateIdeaProjectDialog key={setupDraft.id} project={setupDraft} threadId={threadId} onClose={() => setSetupDraft(null)} />}
    {projectAction && <ProjectActionDialog key={projectAction.id} project={projectAction} onClose={() => setProjectAction(null)} />}
    <ProjectPickerDialog />
  </div>;
}
