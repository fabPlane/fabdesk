import type { Thread } from "@fabdesk/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type MouseEvent } from "react";
import { Button, ContextMenu, IconButton, Input, MenuItem } from "../components/ui";
import { Icon } from "../components/Icon";
import { useCore } from "@fabdesk/client-core";
import { useProjects, useThreads, useThreadMutations } from "@fabdesk/client-core";
import { useBranchThread } from "../hooks/threadActions";
import { useRunsStore } from "@fabdesk/client-core";
import { SIDEBAR_LIST_TABS, SIDEBAR_LIST_TAB_LABELS, normalizeSidebarListTab, useUiStore } from "../stores/ui";
import { cn, formatRelative, modKey } from "../util";
import { groupThreadsByProject } from "@fabdesk/client-core";
import { OpenSourceList } from "./OpenSourceList";
import { UserFooter } from "./UserFooter";

export interface ThreadSidebarProps {
  onNewChat: () => void;
}

interface Menu {
  x: number;
  y: number;
  thread: Thread;
}

export function ThreadSidebar({ onNewChat }: ThreadSidebarProps) {
  const { client, host } = useCore();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const setActiveProject = useUiStore((s) => s.setActiveProject);
  const startNewChatInProject = useUiStore((s) => s.startNewChatInProject);
  const projectId = useUiStore((s) => s.activeProjectId);
  const activeThreadId = useUiStore((s) => s.activeThreadId);
  const setActiveThread = useUiStore((s) => s.setActiveThread);
  const sidebarListTab = normalizeSidebarListTab(useUiStore((s) => s.sidebarListTab));
  const setSidebarListTab = useUiStore((s) => s.setSidebarListTab);
  const setActiveOpenSourceId = useUiStore((s) => s.setActiveOpenSourceId);
  const projects = useProjects();
  const threads = useThreads({ q });
  const projectGroups = useMemo(
    () => groupThreadsByProject(threads.data ?? [], projects.data ?? []),
    [threads.data, projects.data],
  );
  const { patch, remove } = useThreadMutations();
  const branch = useBranchThread();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const running = useRunsStore((s) => s.runsByThread);

  const openMenu = (e: MouseEvent, thread: Thread) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, thread });
  };

  // Electron renderers do not implement window.prompt, so text questions use an inline row.
  const [ask, setAsk] = useState<{ kind: "project" } | null>(null);
  const [askValue, setAskValue] = useState("");

  const createProject = async (name: string) => {
    const p = await client.createProject(name);
    await qc.invalidateQueries({ queryKey: ["projects"] });
    setActiveProject(p.id);
  };

  const submitAsk = async () => {
    const value = askValue.trim();
    setAsk(null);
    setAskValue("");
    if (value) await createProject(value);
  };

  const askRow = ask && (
    <form
      className="flex items-center gap-1 px-2 pt-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submitAsk();
      }}
    >
      <Input
        autoFocus
        value={askValue}
        placeholder="Project name"
        onChange={(e) => setAskValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setAsk(null);
            setAskValue("");
          }
        }}
        className="h-7 min-w-0 flex-1 text-xs"
        data-testid="sidebar-ask"
      />
      <Button size="sm" variant="primary" type="submit">
        OK
      </Button>
    </form>
  );

  const togglePin = (thread: Thread) => {
    patch.mutate({ id: thread.id, patch: { pinned: !thread.pinned } });
  };

  const renderThread = (t: Thread) => (
    <div key={t.id} className="group relative">
      {renaming?.id === t.id ? (
        <form
          className="px-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (renaming.title.trim()) patch.mutate({ id: t.id, patch: { title: renaming.title.trim() } });
            setRenaming(null);
          }}
        >
          <Input
            autoFocus
            value={renaming.title}
            onChange={(e) => setRenaming({ id: t.id, title: e.target.value })}
            onBlur={() => setRenaming(null)}
            className="h-7 text-xs"
          />
        </form>
      ) : (
        <button
          className={cn(
            "flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 pr-14 text-left text-[13px] transition-colors",
            t.id === activeThreadId ? "bg-panel-2 font-medium text-fg shadow-sm" : "text-fg/85 hover:bg-panel-2/60 hover:text-fg",
          )}
          onClick={() => openThread(t.id, t.projectId)}
          onContextMenu={(e) => openMenu(e, t)}
          data-testid={`sidebar-thread-${t.id}`}
        >
          {running[t.id] && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" title="running" />}
          {t.pinned && (
            <span className="text-accent" title="Pinned">
              <Icon name="pin" width={13} height={13} />
            </span>
          )}
          <span className="min-w-0 flex-1 truncate">{t.title || "Untitled"}</span>
          <span className="shrink-0 text-[11px] text-muted opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
            {formatRelative(t.updatedAt)}
          </span>
        </button>
      )}
      <IconButton
        title={t.pinned ? "Unpin" : "Pin"}
        className={cn("absolute right-7 top-1 h-7 w-7", t.pinned ? "text-accent opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100")}
        onClick={(e) => {
          e.stopPropagation();
          togglePin(t);
        }}
        data-testid={`thread-pin-${t.id}`}
      >
        <Icon name="pin" width={13} height={13} />
      </IconButton>
      <IconButton
        title="Thread menu"
        className="absolute right-0 top-1 h-7 w-7 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
        onClick={(e) => openMenu(e, t)}
        data-testid={`thread-menu-${t.id}`}
      >
        <Icon name="more" />
      </IconButton>
    </div>
  );

  const openThread = (id: string, threadProjectId?: string | null) => {
    setActiveOpenSourceId(null);
    setActiveProject(threadProjectId ?? null);
    setActiveThread(id);
  };

  return (
    <div className="fd-sidebar flex h-full flex-col">
      <nav className="fd-sidebar-nav" aria-label="Workspace navigation">
        {SIDEBAR_LIST_TABS.map((id) => (
          <button key={id} type="button" aria-current={sidebarListTab === id ? "page" : undefined} onClick={() => setSidebarListTab(id)}>
            <Icon name={id === "projects" ? "folder" : "library"} width={17} height={17} />
            {SIDEBAR_LIST_TAB_LABELS[id]}
          </button>
        ))}
      </nav>
      {sidebarListTab === "projects" && (
        <>
          <div className="flex items-center justify-between px-3 pt-3">
            <span className="text-[11px] font-medium text-muted">Workspace</span>
            <IconButton title="New project" onClick={() => { setAskValue(""); setAsk({ kind: "project" }); }}>
              <Icon name="plus" />
            </IconButton>
          </div>
          {askRow}
          <div className="px-3 pt-2">
            <Button variant="secondary" className="fd-new-chat-button w-full" onClick={onNewChat} data-testid="sidebar-new-chat">
              <Icon name="plus" width={16} height={16} /><span className="flex-1 text-left">New chat</span>
              <span className="text-[11px] opacity-70">{modKey(host.platform)}&#8679;O</span>
            </Button>
          </div>
          <div className="fd-sidebar-search relative mx-3 mb-3 mt-3">
            <Icon name="search" width={15} height={15} className="pointer-events-none absolute left-2.5 top-2.5 text-muted" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search threads..." aria-label="Search threads" />
          </div>
        </>
      )}
      {sidebarListTab === "open_source" ? (
        <OpenSourceList />
      ) : (
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-1">
        {threads.isLoading && <div className="px-2 py-3 text-xs text-muted">Loading...</div>}
        {threads.isError && <div className="px-2 py-3 text-xs text-danger">Could not load threads</div>}
        {projectGroups.map((group) => (
          <div key={group.key} className="mb-1" data-testid={`sidebar-group-${group.key}`}>
            <div className="group relative flex items-center gap-0.5 px-0.5">
              <button
                type="button"
                className={cn(
                  "fd-project-row flex min-h-9 min-w-0 flex-1 items-center justify-between rounded-md px-2 text-left text-[13px] hover:bg-panel-2/60 hover:text-fg",
                  group.kind === "project" && group.projectId === projectId ? "bg-panel-2/50 text-fg" : "text-muted",
                )}
                aria-current={group.kind === "project" && group.projectId === projectId ? "true" : undefined}
                onClick={() => group.kind === "project" && group.projectId && setActiveProject(group.projectId)}
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  {group.kind === "pinned" && <Icon name="pin" width={13} height={13} />}
                  {group.kind === "project" && <Icon name="folder" width={15} height={15} className="shrink-0 opacity-65" />}
                  <span className="min-w-0 truncate" title={group.title}>{group.title}</span>
                </span>
                <span className="fd-project-count ml-2 shrink-0 text-[10px] tabular-nums text-muted">{group.threads.length}</span>
              </button>
              {group.kind === "project" && group.projectId && (
                <IconButton
                  title={`New chat in ${group.title}`}
                  className="fd-project-add absolute right-0 top-0 text-muted opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-fg"
                  onClick={(e) => {
                    e.stopPropagation();
                    startNewChatInProject(group.projectId);
                  }}
                  data-testid={`project-new-chat-${group.projectId}`}
                >
                  <Icon name="plus" />
                </IconButton>
              )}
            </div>
            {group.threads.map(renderThread)}
          </div>
        ))}
        {!threads.isLoading && projectGroups.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-muted">No projects yet.</div>
        )}
      </div>
      )}
      <UserFooter />
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <MenuItem
            onClick={() => {
              togglePin(menu.thread);
              setMenu(null);
            }}
          >
            {menu.thread.pinned ? "Unpin" : "Pin"}
          </MenuItem>
          <MenuItem
            onClick={() => {
              setRenaming({ id: menu.thread.id, title: menu.thread.title });
              setMenu(null);
            }}
          >
            Rename
          </MenuItem>
          <MenuItem
            onClick={() => {
              void branch(menu.thread);
              setMenu(null);
            }}
          >
            Branch
          </MenuItem>
          <MenuItem
            danger
            onClick={() => {
              if (window.confirm(`Delete "${menu.thread.title}"?`)) {
                remove.mutate(menu.thread.id);
                if (activeThreadId === menu.thread.id) setActiveThread(null);
              }
              setMenu(null);
            }}
          >
            Delete
          </MenuItem>
        </ContextMenu>
      )}
    </div>
  );
}
