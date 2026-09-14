/**
 * What the Chats list remembers between launches: sort mode, folded groups and when each thread
 * was last on screen. The rules live in `lib/chat-list.ts`; this is only the persisted state and
 * the handful of actions the screens call.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  freshPrefs,
  parsePrefs,
  toggleCollapsed,
  withSeen,
  type ChatListPrefs,
  type SortMode,
} from "@/lib/chat-list";
import { jsonStorage } from "./storage";

export interface ChatListState extends ChatListPrefs {
  hydrated: boolean;
  setSort: (sort: SortMode) => void;
  toggleGroup: (key: string) => void;
  /** Call when a thread is on screen; `updatedAt` guards against a daemon clock that runs ahead. */
  markSeen: (threadId: string, updatedAt?: string) => void;
}

export const useChatList = create<ChatListState>()(
  persist(
    (set, get) => ({
      ...freshPrefs(),
      hydrated: false,
      setSort: (sort) => set({ sort }),
      toggleGroup: (key) => set({ collapsed: toggleCollapsed(get().collapsed, key) }),
      markSeen: (threadId, updatedAt) => {
        const next = withSeen(get().lastSeen, threadId, updatedAt);
        if (next !== get().lastSeen) set({ lastSeen: next });
      },
    }),
    {
      name: "fabdesk.chat-list",
      storage: jsonStorage(),
      partialize: ({ sort, collapsed, lastSeen, baseline }) => ({
        sort,
        collapsed,
        lastSeen,
        baseline,
      }),
      merge: (persisted, current) => ({ ...current, ...parsePrefs(persisted) }),
      onRehydrateStorage: () => (state) => {
        // Runs after the persisted values are merged (or after a failed read, with `state` still
        // the defaults). The first launch stamps the baseline so history before it counts as read.
        useChatList.setState({
          hydrated: true,
          baseline: state?.baseline ?? new Date().toISOString(),
        });
      },
    },
  ),
);
