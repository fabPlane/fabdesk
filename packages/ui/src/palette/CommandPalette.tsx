import { Command } from "cmdk";
import { useCallback, useDeferredValue, useState } from "react";
import { useAppActions } from "../app/useAppActions";
import { Dialog, Kbd } from "../components/ui";
import { useCore } from "@fabdesk/client-core";
import { useAuthStore, useChatSearch, useProjects, useThreads } from "@fabdesk/client-core";
import { openChatSearchResult } from "../chat/SearchResults";
import { BOARD_TABS, BOARD_TAB_LABELS, useUiStore } from "../stores/ui";
import { modKey } from "../util";

export function CommandPalette() {
  const { host } = useCore();
  const open = useUiStore((s) => s.paletteOpen);
  const setOpen = useUiStore((s) => s.setPaletteOpen);
  const setActiveThread = useUiStore((s) => s.setActiveThread);
  const setActiveProject = useUiStore((s) => s.setActiveProject);
  const setBoardTab = useUiStore((s) => s.setBoardTab);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const toggleBoard = useUiStore((s) => s.toggleBoard);
  const setSidebarListTab = useUiStore((s) => s.setSidebarListTab);
  const setInventoryOpen = useUiStore((s) => s.setInventoryOpen);
  const dashboardUrl = useAuthStore((s) => s.state?.dashboardUrl);
  const actions = useAppActions();
  const threads = useThreads();
  const projects = useProjects();
  const [query, setQuery] = useState("");
  const search = useChatSearch(useDeferredValue(query));
  const searchGroups = new Map<string, { title: string; hits: Array<{ id: string; snippet: string; thread: NonNullable<typeof search.data>["pages"][number]["titles"][number] }> }>();
  for (const hit of search.data?.pages.flatMap((page) => page.messages) ?? []) {
    const group = searchGroups.get(hit.thread.id) ?? { title: hit.thread.title || "Untitled", hits: [] };
    group.hits.push({ id: hit.message.id, snippet: hit.snippet, thread: hit.thread });
    searchGroups.set(hit.thread.id, group);
  }
  const close = useCallback(() => { setOpen(false); setQuery(""); }, [setOpen]);
  const mod = modKey(host.platform);
  const pick = (fn: () => void) => () => {
    close();
    fn();
  };
  return (
    <Dialog open={open} onClose={close} bare ariaLabel="Command palette" className="w-[560px] max-w-full">
      <Command label="Command palette" className="flex max-h-[70vh] flex-col">
        <Command.Input
          // Dialog records the opener before focusing this input. React autoFocus
          // runs earlier and would make the removed input the restore target.
          value={query}
          onValueChange={setQuery}
          placeholder="Type a command or search chats..."
          className="h-12 shrink-0 w-full border-b border-border bg-transparent px-4 text-sm outline-none placeholder:text-muted"
        />
        <Command.List className="min-h-0 flex-1 overflow-auto p-1.5">
          <Command.Empty>No results.</Command.Empty>
          <Command.Group heading="Actions">
            <Command.Item value="new chat" onSelect={pick(actions.newChat)}>
              New chat <span className="ml-auto"><Kbd>{mod} + Shift + O</Kbd></span>
            </Command.Item>
            <Command.Item value="route board" onSelect={pick(() => void actions.routeBoard())}>
              Route board
            </Command.Item>
            <Command.Item value="run drc" onSelect={pick(() => void actions.runDrc())}>
              Run DRC
            </Command.Item>
            <Command.Item value="render board" onSelect={pick(() => void actions.renderBoard())}>
              Render board
            </Command.Item>
            <Command.Item value="export solder stencil" onSelect={pick(() => void actions.exportStencil())}>
              Export solder stencil
            </Command.Item>
            <Command.Item value="pin thread" onSelect={pick(() => void actions.pinThread())}>
              Pin / unpin chat <span className="ml-auto"><Kbd>{mod} + Shift + P</Kbd></span>
            </Command.Item>
            <Command.Item value="branch thread" onSelect={pick(() => void actions.branchThread())}>
              Branch chat <span className="ml-auto"><Kbd>{mod} + Shift + D</Kbd></span>
            </Command.Item>
            <Command.Item value="sketch" onSelect={pick(actions.openSketch)}>
              Open sketch pad <span className="ml-auto"><Kbd>{mod} + Shift + S</Kbd></span>
            </Command.Item>
            <Command.Item value="settings" onSelect={pick(actions.openSettings)}>
              Settings <span className="ml-auto"><Kbd>{mod} + ,</Kbd></span>
            </Command.Item>
            <Command.Item value="parts inventory" onSelect={pick(() => setInventoryOpen(true))}>
              Parts Inventory
            </Command.Item>
            {dashboardUrl && (
              <Command.Item value="fabplane dashboard" onSelect={pick(() => void host.openExternal(dashboardUrl))}>
                Open fabplane dashboard
              </Command.Item>
            )}
            <Command.Item value="toggle sidebar" onSelect={pick(toggleSidebar)}>
              Toggle sidebar <span className="ml-auto"><Kbd>{mod} + B</Kbd></span>
            </Command.Item>
            <Command.Item value="toggle board panel" onSelect={pick(toggleBoard)}>
              Toggle board panel <span className="ml-auto"><Kbd>{mod} + Shift + B</Kbd></span>
            </Command.Item>
          </Command.Group>
          <Command.Group heading="Board tabs">
            {BOARD_TABS.map((tab, i) => (
              <Command.Item key={tab} value={`tab ${BOARD_TAB_LABELS[tab]}`} onSelect={pick(() => setBoardTab(tab))}>
                {BOARD_TAB_LABELS[tab]} <span className="ml-auto"><Kbd>{mod} + {i + 1}</Kbd></span>
              </Command.Item>
            ))}
          </Command.Group>
          {(projects.data?.length ?? 0) > 0 && (
            <Command.Group heading="Projects">
              {projects.data!.map((p) => (
                <Command.Item key={p.id} value={`project ${p.name}`} onSelect={pick(() => setActiveProject(p.id))}>
                  {p.name}
                </Command.Item>
              ))}
            </Command.Group>
          )}
          {query.trim().length < 2 && (threads.data?.length ?? 0) > 0 && (
            <Command.Group heading="Chats">
              {threads.data!.map((t) => (
                <Command.Item key={t.id} value={`thread ${t.title} ${t.id}`} onSelect={pick(() => { setActiveProject(t.projectId ?? null); setActiveThread(t.id); })}>
                  <span className="truncate">{t.title || "Untitled"}</span>
                  {t.pinned && <span className="ml-auto text-[10px] text-muted">pinned</span>}
                </Command.Item>
              ))}
            </Command.Group>
          )}
          {query.trim().length >= 2 && search.data && <>
            {search.data.pages[0]?.titles.length ? <Command.Group heading="Matching chat titles">
              {search.data.pages[0].titles.map((thread) => <Command.Item key={`title-${thread.id}`} value={`${query} ${thread.title}`} onSelect={() => openChatSearchResult(thread)}>{thread.title || "Untitled"}{thread.archived && <span className="ml-auto text-xs text-muted">Archived</span>}</Command.Item>)}
            </Command.Group> : null}
            {[...searchGroups.entries()].map(([threadId, group]) => <Command.Group key={threadId} heading={`Messages · ${group.title}`}>
              {group.hits.map(({ id, snippet, thread }) => <Command.Item key={id} value={`${query} ${thread.title} ${id}`} onSelect={() => openChatSearchResult(thread, id)}>
                <span className="block min-w-0 truncate text-xs text-muted">{snippet}</span>
              </Command.Item>)}
            </Command.Group>)}
            {search.hasNextPage && <Command.Group heading="More results"><Command.Item value={`${query} load more messages`} onSelect={() => void search.fetchNextPage()}>{search.isFetchingNextPage ? "Loading…" : "Load more messages"}</Command.Item></Command.Group>}
          </>}
          {query.trim().length >= 2 && search.isPending && <Command.Group heading="Search"><Command.Item disabled value={`${query} loading`}>Searching messages…</Command.Item></Command.Group>}
          {query.trim().length >= 2 && search.isError && <Command.Group heading="Search"><Command.Item value={`${query} retry search`} onSelect={() => void search.refetch()}>Search failed. Try again</Command.Item></Command.Group>}
        </Command.List>
      </Command>
    </Dialog>
  );
}
