import type { Thread } from "@fabdesk/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type MouseEvent } from "react";
import { Button, ContextMenu, IconButton, Input, MenuItem, Tabs } from "../components/ui";
import { useCore } from "@fabdesk/client-core";
import { useProjects, useThreads, useThreadMutations } from "@fabdesk/client-core";
import { useBranchThread } from "../hooks/threadActions";
import { useRunsStore } from "@fabdesk/client-core";
import { SIDEBAR_LIST_TABS, SIDEBAR_LIST_TAB_LABELS, normalizeSidebarListTab, useUiStore } from "../stores/ui";
import { cn, formatRelative, modKey } from "../util";
import { groupThreadsByProject } from "@fabdesk/client-core";
import { OpenSourceList } from "./OpenSourceList";
import { InventorySidebar } from "./InventorySidebar";
import { UserFooter } from "./UserFooter";

export interface ThreadSidebarProps {
  onNewChat: () => void;
}

interface Menu {
  x: number;
  y: number;
  thread: Thread;
}

function PinMark() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden className="shrink-0">
      <path
        fill="currentColor"
        d="M10.16 1.4a1.1 1.1 0 0 1 1.56 0l1.38 1.38a1.1 1.1 0 0 1 0 1.56l-1.1 1.1.28 1.5a.9.9 0 0 1-.24.82L8.7 9.1l3.18 3.18-1.06 1.06L7.64 10.16l-2.1 3.26a.85.85 0 0 1-1.45-.18l-.62-1.24a.85.85 0 0 1 .16-.96l2.26-1.46-2.72-2.72a.9.9 0 0 1 .82-.24l1.5.28 1.1-1.1z"
      />
    </svg>
  );
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
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 pr-14 text-left text-[13px]",
            t.id === activeThreadId ? "bg-panel-2 text-fg" : "text-fg/90 hover:bg-panel-2/70",
          )}
          onClick={() => openThread(t.id, t.projectId)}
          onContextMenu={(e) => openMenu(e, t)}
          data-testid={`sidebar-thread-${t.id}`}
        >
          {running[t.id] && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" title="running" />}
          {t.pinned && (
            <span className="text-accent" title="Pinned">
              <PinMark />
            </span>
          )}
          <span className="min-w-0 flex-1 truncate">{t.title || "Untitled"}</span>
          <span className="shrink-0 text-[10px] text-muted opacity-0 group-hover:opacity-100">
            {formatRelative(t.updatedAt)}
          </span>
        </button>
      )}
      <IconButton
        title={t.pinned ? "Unpin" : "Pin"}
        className={cn("absolute right-6 top-1 h-5 w-5", t.pinned ? "text-accent opacity-100" : "opacity-0 group-hover:opacity-100")}
        onClick={(e) => {
          e.stopPropagation();
          togglePin(t);
        }}
        data-testid={`thread-pin-${t.id}`}
      >
        <PinMark />
      </IconButton>
      <IconButton
        title="Thread menu"
        className="absolute right-1 top-1 h-5 w-5 opacity-0 group-hover:opacity-100"
        onClick={(e) => openMenu(e, t)}
        data-testid={`thread-menu-${t.id}`}
      >
        &#8943;
      </IconButton>
    </div>
  );

  const openThread = (id: string, threadProjectId?: string | null) => {
    setActiveOpenSourceId(null);
    setActiveProject(threadProjectId ?? null);
    setActiveThread(id);
  };

  return (
    <div className="flex h-full flex-col bg-panel">
      <Tabs
        className="px-2 pt-2"
        tabs={SIDEBAR_LIST_TABS.map((id) => ({ id, label: SIDEBAR_LIST_TAB_LABELS[id] }))}
        value={sidebarListTab}
        onChange={setSidebarListTab}
      />
      {sidebarListTab === "projects" && (
        <>
          <div className="flex items-center justify-end px-2 pt-2">
            <IconButton title="New project" onClick={() => { setAskValue(""); setAsk({ kind: "project" }); }}>
              +
            </IconButton>
          </div>
          {askRow}
          <div className="px-2 pt-2">
            <Button variant="primary" className="w-full justify-between" onClick={onNewChat} data-testid="sidebar-new-chat">
              <span>New chat</span>
              <span className="text-[10px] opacity-70">{modKey(host.platform)}&#8679;O</span>
            </Button>
          </div>
          <div className="px-2 pt-2">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search threads..." className="h-7 text-xs" />
          </div>
        </>
      )}
      {sidebarListTab === "open_source" ? (
        <OpenSourceList />
      ) : sidebarListTab === "inventory" ? (
        <InventorySidebar />
      ) : (
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2 pt-1">
        {threads.isLoading && <div className="px-2 py-3 text-xs text-muted">Loading...</div>}
        {threads.isError && <div className="px-2 py-3 text-xs text-danger">Could not load threads</div>}
        {projectGroups.map((group) => (
          <div key={group.key} className="mb-2" data-testid={`sidebar-group-${group.key}`}>
            <div className="flex items-center gap-0.5 px-1 pb-1 pt-2">
              <button
                type="button"
                className={cn(
                  "flex min-w-0 flex-1 items-center justify-between px-1 text-left text-[10.5px] font-semibold uppercase tracking-wide hover:text-fg",
                  group.kind === "project" && group.projectId === projectId ? "text-fg" : "text-muted",
                )}
                aria-current={group.kind === "project" && group.projectId === projectId ? "true" : undefined}
                onClick={() => group.kind === "project" && group.projectId && setActiveProject(group.projectId)}
              >
                <span className="flex min-w-0 items-center gap-1 truncate">
                  {group.kind === "pinned" && <PinMark />}
                  {group.title}
                </span>
                <span className="shrink-0 pl-1">{group.threads.length}</span>
              </button>
              {group.kind === "project" && group.projectId && (
                <IconButton
                  title={`New chat in ${group.title}`}
                  className="ml-auto h-5 w-5 shrink-0 text-muted hover:text-fg"
                  onClick={(e) => {
                    e.stopPropagation();
                    startNewChatInProject(group.projectId);
                  }}
                  data-testid={`project-new-chat-${group.projectId}`}
                >
                  +
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
