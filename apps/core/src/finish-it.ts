/**
 * Finish it: one-click autonomous mode that drives the existing agent + MCP pipeline
 * (netlist → build → route → DRC/ERC/SPICE) and commits each completed milestone.
 */
import {
  FINISH_IT_MILESTONE_LABELS,
  type AgentId,
  type CoreEvent,
  type FinishItCommit,
  type FinishItMilestoneId,
  type FinishItSession,
  type FinishItStatus,
  type Settings,
} from "@fabdesk/protocol";
import { ToolError, type ProjectHandle } from "@fabdesk/tools";
import type { AgentRunManager } from "./agent-runs";
import type { EventBus } from "./bus";
import { newId, type Store } from "./db";
import { commitMilestone } from "./finish-it-git";
import {
  finishItPrompt,
  inspectProject,
  milestoneDone,
  milestoneForTool,
  planMilestones,
  remainingMilestones,
  snapshotNote,
  type FinishItRouteHint,
  type FinishItSnapshot,
} from "./finish-it-plan";
import { errMsg, logger } from "./log";
import type { ProjectStore } from "./projects";

export { finishItPrompt, inspectProject, milestoneForTool, planMilestones } from "./finish-it-plan";

const TERMINAL: ReadonlySet<FinishItStatus> = new Set(["completed", "stopped", "failed"]);

export type FinishItStartInput = {
  projectId: string;
  threadId?: string;
  agentId?: AgentId;
  model?: string;
};

export type FinishItDeps = {
  store: Store;
  bus: EventBus;
  runs: AgentRunManager;
  projects: ProjectStore;
  settings: () => Settings;
  commit?: (dir: string, message: string) => Promise<string | null>;
  maxFollowUps?: number;
};

type Live = {
  session: FinishItSession;
  stopping: boolean;
  abortWait: (() => void) | null;
};

export class FinishItManager {
  private readonly live = new Map<string, Live>();
  private readonly syncTail = new Map<string, Promise<void>>();
  private readonly unsub: () => void;
  private readonly commit: (dir: string, message: string) => Promise<string | null>;
  private readonly maxFollowUps: number;

  constructor(private readonly deps: FinishItDeps) {
    this.commit = deps.commit ?? ((dir, message) => commitMilestone(dir, message));
    this.maxFollowUps = deps.maxFollowUps ?? 2;
    this.unsub = deps.bus.subscribe(
      ["agent.tool_use", "agent.tool_result", "agent.done", "project.changed", "job.done"],
      (events) => {
        for (const { event } of events) this.onEvent(event);
      },
      { coalesceMs: 0 },
    );
  }

  close(): void {
    this.unsub();
  }

  get(projectId: string): FinishItSession | null {
    return this.live.get(projectId)?.session ?? this.deps.store.finishIt.latestForProject(projectId);
  }

  async start(input: FinishItStartInput): Promise<FinishItSession> {
    const project = await this.deps.projects.handle(input.projectId);
    if (!project) throw new ToolError("project not found", "not_found");
    if (this.live.has(project.id) || this.deps.store.finishIt.activeForProject(project.id))
      throw new ToolError("a Finish it run is already active on this project", "precondition");
    if (!this.deps.runs)
      throw new ToolError("agent runs are disabled in this daemon", "unavailable");

    const settings = this.deps.settings();
    let thread = input.threadId ? this.deps.store.threads.get(input.threadId) : null;
    if (input.threadId && !thread) throw new ToolError("thread not found", "not_found");
    if (thread && thread.projectId !== project.id)
      throw new ToolError("thread does not belong to this project", "invalid_args");
    const agentId: AgentId = input.agentId ?? thread?.agentId ?? settings.defaultAgent;
    const model = input.model ?? thread?.model ?? settings.agents[agentId]?.model ?? undefined;
    if (!thread) {
      thread = this.deps.store.threads.create({
        projectId: project.id,
        title: "Finish it",
        agentId,
        ...(model ? { model } : {}),
        runtimeMode: "full",
      });
      this.deps.bus.emit({
        ts: Date.now(),
        topic: "thread.created",
        threadId: thread.id,
        projectId: project.id,
      });
    } else if (thread.agentId !== agentId || (model && thread.model !== model)) {
      this.deps.store.threads.patch(thread.id, { agentId, ...(model ? { model } : {}) });
    }

    const busy = this.deps.runs.projectBusyMessage(project.id);
    if (busy)
      throw new ToolError(busy.message, "precondition");

    const snap = await this.snapshot(project);
    const milestones = planMilestones(snap);
    const now = new Date().toISOString();
    const session: FinishItSession = {
      id: newId("fin"),
      projectId: project.id,
      threadId: thread.id,
      runId: null,
      status: "running",
      currentMilestone: remainingMilestones(milestones)[0] ?? null,
      milestones,
      commits: [],
      error: null,
      startedAt: now,
      endedAt: null,
    };
    this.deps.store.finishIt.insert(session);
    this.live.set(project.id, { session, stopping: false, abortWait: null });
    this.deps.bus.emit({ ts: Date.now(), topic: "finish_it.started", session });
    if (remainingMilestones(milestones).length === 0) {
      this.finish(project.id, "completed");
      return this.get(project.id) ?? session;
    }
    void this.loop(project, thread.id, agentId, model);
    return session;
  }

  async stop(projectId: string): Promise<FinishItSession | null> {
    const live = this.live.get(projectId);
    const stored = this.deps.store.finishIt.activeForProject(projectId);
    const session = live?.session ?? stored;
    if (!session || TERMINAL.has(session.status)) return this.get(projectId);
    if (live) live.stopping = true;
    this.patch(session.projectId, (s) => ({ ...s, status: "stopping" }));
    const threadId = session.threadId;
    await this.deps.runs.abortThread(threadId);
    live?.abortWait?.();
    const latest = this.live.get(projectId)?.session ?? this.deps.store.finishIt.get(session.id);
    if (latest && !TERMINAL.has(latest.status)) this.finish(projectId, "stopped");
    return this.get(projectId);
  }

  private async loop(
    project: ProjectHandle,
    threadId: string,
    agentId: AgentId,
    model: string | undefined,
  ): Promise<void> {
    let followUps = 0;
    try {
      for (;;) {
        const live = this.live.get(project.id);
        if (!live || live.stopping) {
          this.finish(project.id, "stopped");
          return;
        }
        await this.syncMilestones(project);
        const session = this.live.get(project.id)?.session;
        if (!session) return;
        const remaining = remainingMilestones(session.milestones);
        if (remaining.length === 0) {
          this.finish(project.id, "completed");
          return;
        }
        if (followUps > this.maxFollowUps) {
          this.finish(
            project.id,
            "failed",
            `agent stopped after ${this.maxFollowUps} follow-up${this.maxFollowUps === 1 ? "" : "s"} with work still remaining: ${remaining.join(", ")}`,
          );
          return;
        }
        if (this.deps.runs.isRunning(threadId)) {
          await this.waitForRun(project.id, this.deps.store.runs.latestForThread(threadId)?.id ?? "");
          continue;
        }
        const busy = this.deps.runs.projectBusyMessage(project.id);
        if (busy && busy.threadId !== threadId) {
          this.finish(project.id, "failed", busy.message);
          return;
        }
        const snap = await this.snapshot(project);
        const prompt = finishItPrompt({
          projectName: project.name,
          snapshot: snap,
          remaining,
          ...(followUps > 0 ? { followUp: true } : {}),
        });
        this.deps.store.threads.addMessage({
          threadId,
          role: "user",
          contentMd: prompt,
          parts: [{ type: "text", text: prompt }],
        });
        this.deps.bus.emit({ ts: Date.now(), topic: "thread.updated", threadId });
        const first = remaining[0];
        if (first) this.markRunning(project.id, first, snapshotNote(first, snap));
        const started = await this.deps.runs.start({
          threadId,
          project,
          agentId,
          ...(model ? { model } : {}),
          prompt,
          attachments: [],
        });
        this.patch(project.id, (s) => ({ ...s, runId: started.runId }));
        const done = await this.waitForRun(project.id, started.runId);
        if (this.live.get(project.id)?.stopping || done === "aborted") {
          this.finish(project.id, "stopped");
          return;
        }
        this.settleRunning(project.id, done === "failed" ? "failed" : "pending");
        followUps += 1;
      }
    } catch (error) {
      logger.warn("finish-it loop failed", { projectId: project.id, error: errMsg(error) });
      this.finish(project.id, "failed", errMsg(error));
    }
  }

  private waitForRun(projectId: string, runId: string): Promise<"completed" | "aborted" | "failed"> {
    const live = this.live.get(projectId);
    if (!live) return Promise.resolve("aborted");
    if (!runId) return Promise.resolve("completed");
    return new Promise((resolve) => {
      const finish = (status: "completed" | "aborted" | "failed") => {
        live.abortWait = null;
        unsub();
        resolve(status);
      };
      live.abortWait = () => finish("aborted");
      const unsub = this.deps.bus.subscribe(
        ["agent.done"],
        (events) => {
          for (const { event } of events) {
            if (event.topic !== "agent.done" || event.runId !== runId) continue;
            finish(
              event.status === "aborted"
                ? "aborted"
                : event.status === "failed"
                  ? "failed"
                  : "completed",
            );
          }
        },
        { coalesceMs: 0 },
      );
    });
  }

  private onEvent(event: CoreEvent): void {
    if (event.topic === "agent.tool_use") {
      const live = this.liveByRun(event.runId);
      if (!live) return;
      const milestone = milestoneForTool(event.name);
      if (milestone) this.markRunning(live.session.projectId, milestone);
      return;
    }
    if (event.topic === "agent.tool_result" || event.topic === "job.done") {
      const projectId =
        event.topic === "agent.tool_result"
          ? this.liveByRun(event.runId)?.session.projectId
          : this.projectForAnyLive();
      if (projectId) void this.syncMilestonesById(projectId);
      return;
    }
    if (event.topic === "project.changed") {
      if (this.live.has(event.projectId)) void this.syncMilestonesById(event.projectId);
    }
  }

  private liveByRun(runId: string): Live | undefined {
    for (const live of this.live.values()) if (live.session.runId === runId) return live;
    return undefined;
  }

  private projectForAnyLive(): string | undefined {
    return this.live.keys().next().value;
  }

  private async snapshot(project: ProjectHandle): Promise<FinishItSnapshot> {
    const route = this.deps.store.routeRuns.latest(project.id);
    const lastRoute: FinishItRouteHint | null = route
      ? { status: route.status, open: route.result?.open.length ?? null }
      : null;
    return inspectProject(project.dir, { ...(lastRoute ? { lastRoute } : {}) });
  }

  private async syncMilestonesById(projectId: string): Promise<void> {
    const project = await this.deps.projects.handle(projectId);
    if (project) await this.syncMilestones(project);
  }

  private async syncMilestones(project: ProjectHandle): Promise<void> {
    const prev = this.syncTail.get(project.id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.syncTail.set(
      project.id,
      prev.then(() => gate),
    );
    await prev;
    try {
      await this.syncMilestonesLocked(project);
    } finally {
      release();
    }
  }

  private async syncMilestonesLocked(project: ProjectHandle): Promise<void> {
    const live = this.live.get(project.id);
    if (!live || TERMINAL.has(live.session.status)) return;
    const snap = await this.snapshot(project);
    const newlyDone: FinishItMilestoneId[] = [];
    const milestones = live.session.milestones.map((m) => {
      if (m.status === "skipped") return m;
      if (milestoneDone(m.id, snap)) {
        if (m.status !== "done") newlyDone.push(m.id);
        return {
          ...m,
          status: "done" as const,
          note: snapshotNote(m.id, snap),
          endedAt: m.endedAt ?? new Date().toISOString(),
        };
      }
      return { ...m, note: snapshotNote(m.id, snap) };
    });
    let commits = live.session.commits;
    for (const id of newlyDone) {
      try {
        const sha = await this.commit(project.dir, `finish-it: ${FINISH_IT_MILESTONE_LABELS[id]}`);
        if (sha) {
          const commit: FinishItCommit = {
            milestone: id,
            sha,
            message: `finish-it: ${FINISH_IT_MILESTONE_LABELS[id]}`,
            at: new Date().toISOString(),
          };
          commits = [...commits, commit];
          const idx = milestones.findIndex((m) => m.id === id);
          const current = milestones[idx];
          if (current) milestones[idx] = { ...current, commitSha: sha };
          this.emitMilestone({ ...live.session, milestones, commits }, id, sha);
        }
      } catch (error) {
        logger.warn("finish-it commit failed", { projectId: project.id, milestone: id, error: errMsg(error) });
      }
    }
    const remaining = remainingMilestones(milestones);
    this.patch(project.id, (s) => ({
      ...s,
      milestones,
      commits,
      currentMilestone: remaining[0] ?? s.currentMilestone,
    }));
    const next = this.live.get(project.id)?.session ?? live.session;
    this.emitProgress(next, snapshotNote(remaining[0] ?? "verify", snap));
  }

  private markRunning(projectId: string, id: FinishItMilestoneId, note?: string): void {
    this.patch(projectId, (s) => ({
      ...s,
      currentMilestone: id,
      milestones: s.milestones.map((m) =>
        m.id === id && m.status !== "done" && m.status !== "skipped"
          ? {
              ...m,
              status: "running",
              startedAt: m.startedAt ?? new Date().toISOString(),
              ...(note ? { note } : {}),
            }
          : m,
      ),
    }));
    const session = this.live.get(projectId)?.session;
    if (session) this.emitProgress(session, note);
  }

  /** A run ended: whatever it left running is unfinished; the next sync marks it done if it now passes. */
  private settleRunning(projectId: string, status: "pending" | "failed"): void {
    this.patch(projectId, (s) => ({
      ...s,
      milestones: s.milestones.map((m) => (m.status === "running" ? { ...m, status } : m)),
    }));
  }

  private patch(projectId: string, fn: (s: FinishItSession) => FinishItSession): FinishItSession | null {
    const live = this.live.get(projectId);
    if (!live) return null;
    const next = fn(live.session);
    live.session = next;
    this.deps.store.finishIt.update(next);
    return next;
  }

  private finish(projectId: string, status: "completed" | "stopped" | "failed", error?: string): void {
    const live = this.live.get(projectId);
    if (!live) return;
    if (TERMINAL.has(live.session.status) && live.session.status !== "stopping") {
      this.live.delete(projectId);
      return;
    }
    const milestones =
      status === "completed"
        ? live.session.milestones
        : live.session.milestones.map((m) =>
            m.status === "done" || m.status === "skipped"
              ? m
              : { ...m, status: status === "failed" ? ("failed" as const) : m.status === "running" ? ("pending" as const) : m.status },
          );
    const ended: FinishItSession = {
      ...live.session,
      milestones,
      status,
      runId: live.session.runId,
      error: error ?? live.session.error,
      endedAt: new Date().toISOString(),
      currentMilestone: status === "completed" ? null : live.session.currentMilestone,
    };
    live.session = ended;
    this.deps.store.finishIt.update(ended);
    this.live.delete(projectId);
    if (status === "completed") this.deps.bus.emit({ ts: Date.now(), topic: "finish_it.done", session: ended });
    else if (status === "stopped")
      this.deps.bus.emit({ ts: Date.now(), topic: "finish_it.stopped", session: ended });
    else
      this.deps.bus.emit({
        ts: Date.now(),
        topic: "finish_it.failed",
        session: ended,
        error: error ?? ended.error ?? "Finish it failed",
      });
  }

  private emitProgress(session: FinishItSession, note?: string): void {
    this.deps.bus.emit({
      ts: Date.now(),
      topic: "finish_it.progress",
      session,
      ...(note ? { note } : {}),
    });
  }

  private emitMilestone(session: FinishItSession, milestone: FinishItMilestoneId, commitSha: string): void {
    this.deps.bus.emit({ ts: Date.now(), topic: "finish_it.milestone", session, milestone, commitSha });
  }
}
