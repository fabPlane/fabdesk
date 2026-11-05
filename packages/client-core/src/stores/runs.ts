/** Live agent runs and jobs as seen through the event stream. */
import type { AgentId, BoardSourceSelection, Job } from "@fabdesk/protocol";
import { create } from "zustand";

export interface LiveRun {
  runId: string;
  threadId: string;
  agentId: AgentId;
  startedAt: number;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  error?: string;
}

export interface LiveJob {
  jobId: string;
  kind: string;
  projectId?: string;
  endpoint?: string;
  board?: BoardSourceSelection;
  status: Job["status"];
  progress?: number;
  note?: string;
  error?: string;
  result?: unknown;
  startedAt: number;
}

export interface RunsState {
  runsByThread: Record<string, LiveRun>;
  threadByRun: Record<string, string>;
  jobs: Record<string, LiveJob>;
  startRun: (run: LiveRun) => void;
  endRun: (runId: string) => void;
  setRunUsage: (runId: string, usage: NonNullable<LiveRun["usage"]>) => void;
  setRunError: (runId: string, error: string) => void;
  upsertJob: (job: LiveJob) => void;
  patchJob: (jobId: string, patch: Partial<LiveJob>) => void;
}

export const useRunsStore = create<RunsState>()((set) => ({
  runsByThread: {},
  threadByRun: {},
  jobs: {},
  startRun: (run) =>
    set((s) => ({
      runsByThread: { ...s.runsByThread, [run.threadId]: run },
      threadByRun: { ...s.threadByRun, [run.runId]: run.threadId },
    })),
  endRun: (runId) =>
    set((s) => {
      const threadId = s.threadByRun[runId];
      if (!threadId) return {};
      const { [threadId]: _dropped, ...runsByThread } = s.runsByThread;
      void _dropped;
      return { runsByThread };
    }),
  setRunUsage: (runId, usage) =>
    set((s) => {
      const threadId = s.threadByRun[runId];
      const run = threadId ? s.runsByThread[threadId] : undefined;
      if (!threadId || !run) return {};
      return { runsByThread: { ...s.runsByThread, [threadId]: { ...run, usage: { ...run.usage, ...usage } } } };
    }),
  setRunError: (runId, error) =>
    set((s) => {
      const threadId = s.threadByRun[runId];
      const run = threadId ? s.runsByThread[threadId] : undefined;
      if (!threadId || !run) return {};
      return { runsByThread: { ...s.runsByThread, [threadId]: { ...run, error } } };
    }),
  upsertJob: (job) => set((s) => ({ jobs: { ...s.jobs, [job.jobId]: { ...s.jobs[job.jobId], ...job } } })),
  patchJob: (jobId, patch) =>
    set((s) => {
      const existing = s.jobs[jobId];
      if (!existing) return {};
      return { jobs: { ...s.jobs, [jobId]: { ...existing, ...patch } } };
    }),
}));
