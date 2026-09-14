/**
 * The Chats list's ordering, unread and collapse rules, kept apart from React so they can be
 * exercised in Bun. The grouping itself (pinned / no project / projects A–Z) is the desktop's
 * `groupThreadsByProject`; this layer decides what happens *inside* a group and which groups
 * are folded away.
 */
import type { ProjectThreadGroup } from "@fabdesk/client-core";
import type { Thread } from "@fabdesk/protocol";

export type SortMode = "updated" | "created";

export const SORT_MODES: readonly SortMode[] = ["updated", "created"];

export const sortModeLabel: Record<SortMode, string> = {
  updated: "Last message",
  created: "Created",
};

/** The locally persisted part of the list's state. Everything else comes from the daemon. */
export interface ChatListPrefs {
  sort: SortMode;
  /** Group keys (`ProjectThreadGroup.key`) that are folded. */
  collapsed: string[];
  /** ISO timestamp of the last time each thread was on screen, by thread id. */
  lastSeen: Record<string, string>;
  /**
   * ISO timestamp set the first time the store exists on this phone. Threads last updated before
   * it count as read even with no `lastSeen` entry — otherwise a fresh install shows a dot on every
   * chat the desktop ever had.
   */
  baseline: string | null;
}

export const DEFAULT_PREFS: ChatListPrefs = {
  sort: "updated",
  collapsed: [],
  lastSeen: {},
  baseline: null,
};

/** A copy, so a store that mutates in place never edits the shared default. */
export function freshPrefs(): ChatListPrefs {
  return { ...DEFAULT_PREFS, collapsed: [], lastSeen: {} };
}

/**
 * Whatever came back from storage, made safe: unknown keys dropped, wrong types replaced by the
 * default, so a bad write from an older build never wedges the list.
 */
export function parsePrefs(raw: unknown): ChatListPrefs {
  if (!raw || typeof raw !== "object") return freshPrefs();
  const r = raw as Record<string, unknown>;
  const sort = SORT_MODES.includes(r.sort as SortMode) ? (r.sort as SortMode) : DEFAULT_PREFS.sort;
  const collapsed = Array.isArray(r.collapsed)
    ? r.collapsed.filter((k): k is string => typeof k === "string")
    : [];
  const lastSeen: Record<string, string> = {};
  if (r.lastSeen && typeof r.lastSeen === "object") {
    for (const [id, iso] of Object.entries(r.lastSeen as Record<string, unknown>)) {
      if (typeof iso === "string" && Number.isFinite(Date.parse(iso))) lastSeen[id] = iso;
    }
  }
  const baseline =
    typeof r.baseline === "string" && Number.isFinite(Date.parse(r.baseline)) ? r.baseline : null;
  return { sort, collapsed, lastSeen, baseline };
}

/** ISO timestamps compare correctly as strings only when they share a format; go through Date. */
function ms(iso: string): number {
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : 0;
}

/**
 * A thread is unread when it changed after we last looked at it. A thread never looked at falls
 * back to the install baseline; with no baseline either (store not hydrated yet) nothing is unread,
 * which avoids a flash of dots on launch.
 */
export function isUnread(
  thread: Pick<Thread, "id" | "updatedAt">,
  prefs: Pick<ChatListPrefs, "lastSeen" | "baseline">,
): boolean {
  const seen = prefs.lastSeen[thread.id] ?? prefs.baseline;
  if (!seen) return false;
  return ms(thread.updatedAt) > ms(seen);
}

/**
 * Records a look at a thread. The stored time is the later of "now" and the thread's own
 * `updatedAt`: the daemon's clock may run ahead of the phone's, and a thread you are looking at
 * must never come back unread because of that.
 */
export function withSeen(
  lastSeen: Record<string, string>,
  threadId: string,
  updatedAt: string | undefined,
  now: number = Date.now(),
): Record<string, string> {
  const at = Math.max(now, updatedAt ? ms(updatedAt) : 0);
  const iso = new Date(at).toISOString();
  if (lastSeen[threadId] === iso) return lastSeen;
  return { ...lastSeen, [threadId]: iso };
}

export function toggleCollapsed(collapsed: readonly string[], key: string): string[] {
  return collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key];
}

/**
 * Order within a group: threads with a live run first (they are what you came to check on), then
 * newest first by the chosen timestamp. Stable, so equal timestamps keep the daemon's order.
 */
export function sortThreads(
  threads: readonly Thread[],
  mode: SortMode,
  isRunning: (threadId: string) => boolean,
): Thread[] {
  const key = mode === "created" ? "createdAt" : "updatedAt";
  return [...threads].sort((a, b) => {
    const ra = isRunning(a.id) ? 1 : 0;
    const rb = isRunning(b.id) ? 1 : 0;
    if (ra !== rb) return rb - ra;
    return ms(b[key]) - ms(a[key]);
  });
}

export interface ChatSection {
  key: string;
  title: string;
  group: ProjectThreadGroup;
  collapsed: boolean;
  /** Rows to render: the sorted threads, or none while collapsed. */
  data: Thread[];
  /** Counts over the whole group, shown on a collapsed header so it still says something. */
  total: number;
  unread: number;
  running: number;
}

export interface BuildSectionsInput {
  groups: readonly ProjectThreadGroup[];
  prefs: ChatListPrefs;
  isRunning: (threadId: string) => boolean;
}

/** Everything the SectionList needs, derived in one place. */
export function buildSections({ groups, prefs, isRunning }: BuildSectionsInput): ChatSection[] {
  const collapsedSet = new Set(prefs.collapsed);
  return groups.map((group) => {
    const sorted = sortThreads(group.threads, prefs.sort, isRunning);
    const collapsed = collapsedSet.has(group.key);
    return {
      key: group.key,
      title: group.title,
      group,
      collapsed,
      data: collapsed ? [] : sorted,
      total: sorted.length,
      unread: sorted.filter((t) => isUnread(t, prefs)).length,
      running: sorted.filter((t) => isRunning(t.id)).length,
    };
  });
}

/** The thread id a route is showing, if it is a thread route. */
export function threadIdFromPath(pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  const m = /^\/thread\/([^/?#]+)/.exec(pathname);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}
