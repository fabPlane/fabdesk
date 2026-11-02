import type { Message, Thread } from "@fabdesk/protocol";
import { useChatSearch } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";

export function openChatSearchResult(thread: Thread, messageId?: string) {
  const ui = useUiStore.getState();
  ui.setSidebarListTab("projects");
  if (!ui.setActiveProject(thread.projectId)) return;
  ui.setActiveThread(thread.id);
  ui.setFocusMessageId(messageId ?? null);
  ui.setPaletteOpen(false);
}

function Preview({ snippet }: { snippet: string }) {
  return <span className="line-clamp-2 text-[11px] leading-4 text-muted">{snippet}</span>;
}

export function SearchResults({ query, projectId }: { query: string; projectId?: string }) {
  const result = useChatSearch(query);
  const pages = result.data?.pages ?? [];
  const titles: Thread[] = (pages[0]?.titles ?? []).filter(thread => !projectId || thread.projectId === projectId);
  const hits: Array<{ message: Message; snippet: string; thread: Thread }> = pages.flatMap((page) => page.messages).filter(hit => !projectId || hit.thread.projectId === projectId);
  const groups = new Map<string, { thread: Thread; hits: typeof hits }>();
  for (const hit of hits) {
    const group = groups.get(hit.thread.id) ?? { thread: hit.thread, hits: [] };
    group.hits.push(hit);
    groups.set(hit.thread.id, group);
  }
  if (query.trim().length < 2) return <p className="px-3 py-4 text-xs text-muted">Type at least two characters to search messages.</p>;
  if (result.isPending) return <p className="px-3 py-4 text-xs text-muted">Searching chats…</p>;
  if (result.isError) return <div className="px-3 py-4 text-xs text-danger" role="alert">Search failed. <button className="underline" onClick={() => void result.refetch()}>Try again</button></div>;
  return <div className="space-y-3 px-1 pb-3" aria-label="Chat search results">
    {titles.length === 0 && hits.length === 0 && <p className="px-2 py-4 text-xs text-muted">No chats or messages match “{query}”.</p>}
    {titles.length > 0 && <section><h3 className="px-2 py-2 text-[11px] font-medium text-muted">Chats</h3>{titles.map((thread) => <button key={thread.id} className="block w-full rounded-lg px-2 py-2 text-left text-xs hover:bg-panel-2 focus-visible:outline focus-visible:outline-accent" onClick={() => openChatSearchResult(thread)}><span className="block truncate font-medium">{thread.title}</span>{thread.archived && <span className="text-muted">Archived</span>}</button>)}</section>}
    {hits.length > 0 && <section><h3 className="px-2 py-2 text-[11px] font-medium text-muted">Messages by chat</h3>{[...groups.values()].map(({ thread, hits: chatHits }) => <div key={thread.id} className="mb-2"><div className="truncate px-2 py-1 text-[11px] font-medium text-muted">{thread.title || "Untitled"}{thread.archived ? " · Archived" : ""}</div>{chatHits.map(({ message, snippet }) => <button key={message.id} className="block w-full rounded-lg px-2 py-2 text-left hover:bg-panel-2 focus-visible:outline focus-visible:outline-accent" onClick={() => openChatSearchResult(thread, message.id)}><Preview snippet={snippet} /></button>)}</div>)}</section>}
    {result.hasNextPage && <button className="mx-2 rounded-lg border border-border px-3 py-2 text-xs hover:bg-panel-2" disabled={result.isFetchingNextPage} onClick={() => void result.fetchNextPage()}>{result.isFetchingNextPage ? "Loading…" : "Load more messages"}</button>}
  </div>;
}
