import type { Thread } from "@fabdesk/protocol";
import type { LiveRun } from "./stores/runs";

/** A live run alone does not establish project ownership; join only verified thread records. */
export function projectAssistantRuns(projectId: string, threads: readonly Thread[], live: Readonly<Record<string, LiveRun>>) {
  return threads.flatMap(thread => {
    const run = live[thread.id];
    return thread.projectId === projectId && run?.threadId === thread.id ? [{ thread, run }] : [];
  }).sort((a, b) => a.run.startedAt - b.run.startedAt);
}
