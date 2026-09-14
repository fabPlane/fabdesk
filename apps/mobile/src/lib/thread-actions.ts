/**
 * The decisions behind the thread's `…` menu and the Archived screen, without React Native so Bun
 * can test them: what the menu offers for a given thread, what a branch request looks like, and
 * which threads the Archived list shows.
 */
import type { CreateThreadInput } from "@fabdesk/client-core";
import type { Thread } from "@fabdesk/protocol";

export type ThreadAction = "rename" | "pin" | "archive" | "branch" | "delete";

export interface ThreadMenuItem {
  action: ThreadAction;
  label: string;
  destructive: boolean;
}

/** Pin/archive read as toggles so the menu says what tapping will do, not what the thread is. */
export function threadMenuItems(thread: Pick<Thread, "pinned" | "archived">): ThreadMenuItem[] {
  return [
    { action: "rename", label: "Rename", destructive: false },
    { action: "pin", label: thread.pinned ? "Unpin" : "Pin", destructive: false },
    { action: "archive", label: thread.archived ? "Unarchive" : "Archive", destructive: false },
    { action: "branch", label: "Branch from here", destructive: false },
    { action: "delete", label: "Delete", destructive: true },
  ];
}

/** A cleaned-up new title, or null when it is empty or the same as before (nothing to send). */
export function renamedTitle(raw: string | undefined, current: string): string | null {
  const next = (raw ?? "").trim().replace(/\s+/g, " ").slice(0, 200);
  return next && next !== current ? next : null;
}

/**
 * Same shape the desktop's `useBranchThread` sends: same project, agent and model, the parent
 * recorded, and the branch point at the last message so the daemon can replay up to it.
 */
export function branchInput(thread: Thread, lastMessageId: string | undefined): CreateThreadInput {
  return {
    projectId: thread.projectId,
    title: `${truncate(thread.title, 50)} (branch)`,
    agentId: thread.agentId,
    ...(thread.model ? { model: thread.model } : {}),
    parentThreadId: thread.id,
    ...(lastMessageId ? { branchFromMessageId: lastMessageId } : {}),
  };
}

/** Archived threads, newest activity first — the flat list the Archived screen shows. */
export function archivedThreads(threads: readonly Thread[]): Thread[] {
  return threads
    .filter((t) => t.archived)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
