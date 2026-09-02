import type { Thread } from "@fabdesk/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type MouseEvent } from "react";
import { Button, ContextMenu, IconButton, Input, MenuItem, Select } from "../components/ui";
import { useCore } from "../core/CoreProvider";
import { useProjects, useThreads, useThreadMutations } from "../hooks/queries";
import { useBranchThread } from "../hooks/threadActions";
import { useRunsStore } from "../stores/runs";
import { useUiStore } from "../stores/ui";
import { cn, dateGroup, formatRelative, modKey } from "../util";
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
  const projectId = useUiStore((s) => s.activeProjectId);
  const setActiveProject = useUiStore((s) => s.setActiveProject);
  const activeThreadId = useUiStore((s) => s.activeThreadId);
  const setActiveThread = useUiStore((s) => s.setActiveThread);
  const projects = useProjects();
  const threads = useThreads({ q, projectId });
  const { patch, remove } = useThreadMutations();
  const branch = useBranchThread();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const running = useRunsStore((s) => s.runsByThread);

  const groups = useMemo(() => {
    const list = (threads.data ?? []).filter((t) => !t.archived);
    const pinned = list.filter((t) => t.pinned);
    const folders = new Map<string, Thread[]>();
    const dated: Record<"Today" | "Yesterday" | "Older", Thread[]> = { Today: [], Yesterday: [], Older: [] };
    for (const t of list.filter((x) => !x.pinned)) {
      if (t.folderId) {
        const arr = folders.get(t.folderId) ?? [];
        arr.push(t);
        folders.set(t.folderId, arr);
      } else dated[dateGroup(t.updatedAt)].push(t);
    }
    return { pinned, folders, dated };
  }, [threads.data]);

  const openMenu = (e: MouseEvent, thread: Thread) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, thread });
  };

  // Electron renderers do not implement window.prompt, so text questions use an inline row.
  const [ask, setAsk] = useState<{ kind: "project" } | { kind: "folder"; thread: Thread } | null>(null);
  const [askValue, setAskValue] = useState("");

  const createProject = async (name: string) => {
    const p = await client.createProject(name);
    await qc.invalidateQueries({ queryKey: ["projects"] });
    setActiveProject(p.id);
  };

  const submitAsk = async () => {
    const value = askValue.trim();
    const current = ask;
    setAsk(null);
    setAskValue("");
    if (!current) return;
    if (current.kind === "project") {
      if (value) await createProject(value);
    } else {
      patch.mutate({ id: current.thread.id, patch: { folderId: value || null } });
    }
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
        placeholder={ask.kind === "project" ? "Project name" : "Folder name (empty to remove)"}
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
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 pr-7 text-left text-[13px]",
            t.id === activeThreadId ? "bg-panel-2 text-fg" : "text-fg/90 hover:bg-panel-2/70",
          )}
          onClick={() => setActiveThread(t.id)}
          onContextMenu={(e) => openMenu(e, t)}
        >
          {running[t.id] && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" title="running" />}
          <span className="min-w-0 flex-1 truncate">{t.title || "Untitled"}</span>
          <span className="shrink-0 text-[10px] text-muted opacity-0 group-hover:opacity-100">
            {formatRelative(t.updatedAt)}
          </span>
        </button>
      )}
      <IconButton
        title="Thread menu"
        className="absolute right-1 top-1 h-5 w-5 opacity-0 group-hover:opacity-100"
        onClick={(e) => openMenu(e, t)}
      >
        &#8943;
      </IconButton>
    </div>
  );

  const section = (title: string, items: Thread[]) =>
    items.length === 0 ? null : (
      <div key={title} className="mb-2">
        <div className="px-2 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wide text-muted">{title}</div>
        {items.map(renderThread)}
      </div>
    );

  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex items-center gap-1 px-2 pt-2">
        <Select
          value={projectId ?? ""}
          onChange={(e) => setActiveProject(e.target.value || null)}
          className="h-7 min-w-0 flex-1 text-xs"
          title="Project"
        >
          <option value="">All projects</option>
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <IconButton title="New project" onClick={() => { setAskValue(""); setAsk({ kind: "project" }); }}>
          +
        </IconButton>
      </div>
      {askRow}
      <div className="px-2 pt-2">
        <Button variant="primary" className="w-full justify-between" onClick={onNewChat}>
          <span>New chat</span>
          <span className="text-[10px] opacity-70">{modKey(host.platform)}&#8679;O</span>
        </Button>
      </div>
      <div className="px-2 pt-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search threads..." className="h-7 text-xs" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2 pt-1">
        {threads.isLoading && <div className="px-2 py-3 text-xs text-muted">Loading...</div>}
        {threads.isError && <div className="px-2 py-3 text-xs text-danger">Could not load threads</div>}
        {section("Pinned", groups.pinned)}
        {[...groups.folders.entries()].map(([folder, items]) => section(folder, items))}
        {section("Today", groups.dated.Today)}
        {section("Yesterday", groups.dated.Yesterday)}
        {section("Older", groups.dated.Older)}
        {threads.data && threads.data.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-muted">No threads yet.</div>
        )}
      </div>
      <UserFooter />
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <MenuItem
            onClick={() => {
              patch.mutate({ id: menu.thread.id, patch: { pinned: !menu.thread.pinned } });
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
              setAskValue(menu.thread.folderId ?? "");
              setAsk({ kind: "folder", thread: menu.thread });
              setMenu(null);
            }}
          >
            Move to folder...
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
