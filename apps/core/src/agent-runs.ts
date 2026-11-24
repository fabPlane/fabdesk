/**
 * Agent runs: spawn an agent adapter for a thread message, map AgentEvents to `agent.*` bus events
 * and persist the assistant message parts as they stream. Also the home of supervised mode's
 * pending requests (approvals and questions) and of the queued-message drain that runs when a
 * run ends.
 */
import { workspacePrompt, type WorkspaceContext } from "@fabdesk/protocol";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentId,
  ApprovalDecision,
  ApprovalPart,
  ApprovalRequestedEvent,
  ApprovalResolvedBy,
  CoreEvent,
  InputRequestedEvent,
  MessagePart,
  PendingRequests,
  QuestionPart,
  RuntimeMode,
  Settings,
} from "@fabdesk/protocol";
import { ToolError, type ProjectHandle, type ToolAnnotations } from "@fabdesk/tools";
import type { Store } from "./db";
import { newId } from "./db";
import { logger, errMsg } from "./log";
import { captureCoreException } from "./sentry";
import { classifyToolCall, parseAskUserQuestion } from "./supervision";
import type { TokenSet } from "./auth";
import { attachmentsFromImageParts } from "./message-attachments";
import type { AgentTrace, RunTelemetry } from "./run-telemetry";
import { userPathReady } from "./user-path";

import {
  applyImagePolicy,
  type AgentAdapter,
  type AgentEvent,
  type AgentRun,
  type AgentSession,
  type AgentSupervisor,
} from "@fabdesk/agents";

export type AgentAdapterLike = Pick<AgentAdapter, "id" | "run"> & Partial<Pick<AgentAdapter, "detect" | "supportsSupervised" | "images">>;

/** A request nobody answered for this long resolves as `deny` with `by: "timeout"`. */
export const APPROVAL_TIMEOUT_MS = 30 * 60_000;

/**
 * How long `abortThread` waits for the aborted run to wind down before answering anyway. The
 * run keeps its project lease until it has actually ended; this only bounds the HTTP response.
 */
export const ABORT_SETTLE_TIMEOUT_MS = 5_000;

/** Resolves true once every promise has settled, false when `timeoutMs` passes first. */
async function settledWithin(
  pending: Array<Promise<unknown>>,
  timeoutMs: number,
): Promise<boolean> {
  if (!pending.length) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    Promise.allSettled(pending).then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return settled;
}

function appendToolsets(url: string, toolsets: string[]): string {
  if (!toolsets.length) return url;
  const endpoint = new URL(url);
  endpoint.searchParams.set("toolsets", toolsets.join(","));
  // an existing board: the board-start tool set (see mcp-sessions BOARD_START_TOOLS)
  if (toolsets.includes("board")) endpoint.searchParams.set("start", "board");
  return endpoint.toString();
}

function appendMcpProfile(url: string, profile: "substrate" | "planning"): string {
  const endpoint = new URL(url);
  endpoint.searchParams.set("profile", profile);
  return endpoint.toString();
}

export type RunDeps = {
  store: Store;
  emit: (e: CoreEvent) => void;
  tokens: TokenSet;
  mcpUrl: string;
  /** Optional experimental MCP exposure profile appended to each run's endpoint. */
  mcpProfile?: "substrate";
  /** Toolsets to start a run with besides the defaults, from the project (e.g. `board` on an existing placed board). */
  extraToolsets?: (project: ProjectHandle | null) => Promise<string[]>;
  adapters: Partial<Record<AgentId, AgentAdapterLike>>;
  settings: () => Settings;
  /** Regenerates AGENTS.md/CLAUDE.md before the run. */
  prepareProject?: (project: ProjectHandle, agentId: AgentId) => Promise<void>;
  /** Safe, non-secret workbench paths to add explicitly to the spawned agent environment. */
  agentEnvironment?: (input: {
    cwd: string;
    project: ProjectHandle | null;
  }) => Promise<Record<string, string>>;
  workspaceDir: string;
  telemetry?: Pick<RunTelemetry, "startAgentRun">;
  /** Annotations of a fabdesk (or other known) tool, for the supervised-mode classifier. */
  annotationsFor?: (toolName: string, server: string | null) => ToolAnnotations | undefined;
  /** Needed to send queued messages when a run ends (the HTTP route resolves projects the same way). */
  resolveProject?: (projectId: string) => Promise<ProjectHandle | null>;
  projectTransitioning?: (projectId: string) => boolean;
  /** Tests shorten the 30-minute approval timeout. */
  approvalTimeoutMs?: number;
  /** Tests shorten how long an HTTP abort waits for the run to end. */
  abortSettleTimeoutMs?: number;
};

type PendingApproval = {
  kind: "approval";
  event: ApprovalRequestedEvent;
  resolve: (decision: ApprovalDecision, by: ApprovalResolvedBy) => void;
  timer: ReturnType<typeof setTimeout>;
};
type PendingInput = {
  kind: "input";
  event: InputRequestedEvent;
  resolve: (answer: string) => void;
  timer: ReturnType<typeof setTimeout>;
};
type Pending = PendingApproval | PendingInput;

export type ActiveRun = {
  runId: string;
  threadId: string;
  /** The agent the run drives (its MCP config decides the tool timeout the daemon may wait within). */
  agentId: AgentId;
  /** The project the run writes, or null for a scratch run. Held as the project's lease. */
  projectId: string | null;
  runtimeMode: RuntimeMode;
  abort(): void;
  stopping?: boolean;
  /** Settles once the run has ended and released its project lease (before any queued message goes out). */
  ended: Promise<void>;
  /** `ended`, then the queued-message drain. */
  done: Promise<void>;
  /** Appends a part to the run's assistant message and persists it. */
  addPart(part: MessagePart): void;
  /** Patches a part in place (matched by `requestId`) and persists it. */
  patchPart(requestId: string, fn: (p: MessagePart) => MessagePart): void;
  pending: Map<string, Pending>;
};

/** What Claude Code's `--permission-prompt-tool` expects back (as the text of one content block). */
export type PermissionPromptResult =
  | { behavior: "allow"; updatedInput: unknown }
  | { behavior: "deny"; message: string };

type StartInput = {
  threadId: string;
  project: ProjectHandle | null;
  agentId: AgentId;
  model?: string;
  prompt: string;
  workspaceContext?: WorkspaceContext;
  attachments: Array<{ path: string; mime: string; role?: "sketch" | "markup" }>;
};

export class AgentRunManager {
  private readonly active = new Map<string, ActiveRun>();
  /**
   * Runs between the start checks and `active.set`: `start` awaits (mkdir, prepareProject,
   * telemetry) before the run is registered, so two requests must not both pass the checks.
   * Thread ids, and project id → the thread holding it.
   */
  private readonly startingThreads = new Set<string>();
  private readonly startingProjects = new Map<string, string>();
  /** Threads being deleted: nothing may start on them, their queue is not drained. */
  private readonly deletingThreads = new Set<string>();
  /** Project id → threads whose queued message waits for another thread's run to free it. */
  private readonly waitingOnProject = new Map<string, Set<string>>();
  constructor(private readonly deps: RunDeps) {}

  isRunning(threadId: string): boolean {
    return (
      this.startingThreads.has(threadId) ||
      [...this.active.values()].some((r) => r.threadId === threadId)
    );
  }

  /**
   * The thread whose agent run holds `projectId`'s lease, or null when the project is free. One
   * agent writes a project at a time (#93); runs without a project never hold a lease. The lease
   * lives in memory only: a daemon restart kills every agent it spawned and marks their runs
   * failed (`store.runs.failStale()`), so it starts with every project free.
   */
  projectHolder(projectId: string): string | null {
    const starting = this.startingProjects.get(projectId);
    if (starting !== undefined) return starting;
    for (const r of this.active.values()) if (r.projectId === projectId) return r.threadId;
    return null;
  }

  /** The 412 message for a project another thread's run holds, or null when it is free. */
  projectBusyMessage(projectId: string): { threadId: string; message: string } | null {
    const threadId = this.projectHolder(projectId);
    if (threadId === null) return null;
    const title = this.deps.store.threads.get(threadId)?.title;
    return {
      threadId,
      message: `an agent run is already active on this project in thread ${title ? `"${title}" ` : ""}(${threadId}); wait for it to finish or stop it`,
    };
  }

  activeCount(): number {
    return this.active.size;
  }

  /** The runs in progress right now, for a client that connects mid-run. */
  live(): Array<{ runId: string; threadId: string }> {
    return [...this.active.values()].map((r) => ({ runId: r.runId, threadId: r.threadId }));
  }

  supportsSupervised(agentId: AgentId): boolean {
    return this.deps.adapters[agentId]?.supportsSupervised === true;
  }

  /** Whether `token` is the run token of a live supervised run (gates the MCP `permission_prompt` tool). */
  isSupervisedRunToken(token: string | null): boolean {
    const info = this.deps.tokens.lookup(token);
    const run = info?.kind === "run" && info.runId ? this.active.get(info.runId) : undefined;
    return run?.runtimeMode === "supervised";
  }

  /** The agent of the active run this token belongs to, or null. */
  activeRunAgent(token: string | null): AgentId | null {
    const info = this.deps.tokens.lookup(token);
    const run = info?.kind === "run" && info.runId ? this.active.get(info.runId) : undefined;
    return run && !run.stopping ? run.agentId : null;
  }

  isActiveRunToken(token: string | null): boolean {
    const info = this.deps.tokens.lookup(token);
    const run = info?.kind === "run" && info.runId ? this.active.get(info.runId) : undefined;
    return !!run && !run.stopping;
  }

  /** A question belongs to the authenticated run, never to an agent-supplied thread ID. */
  async requestUserInput(
    token: string | null,
    req: { question: string; options?: string[] },
    signal?: AbortSignal,
  ): Promise<{ status: "answered" | "unanswered"; answer: string | null }> {
    const info = this.deps.tokens.lookup(token);
    const run = info?.kind === "run" && info.runId ? this.active.get(info.runId) : undefined;
    if (!run || run.stopping) throw new Error("This question requires an active chat run.");
    const answer = await this.requestInput(run, req, signal);
    return answer ? { status: "answered", answer } : { status: "unanswered", answer: null };
  }

  /**
   * Aborts the thread's run and waits — at most `timeoutMs` — for it to end, so a Stop that
   * answers `settled: true` means the project is free for the next run. A run that outlives the
   * wait still holds its lease until it really ends; only the answer stops waiting.
   */
  async abortThread(
    threadId: string,
    timeoutMs = this.deps.abortSettleTimeoutMs ?? ABORT_SETTLE_TIMEOUT_MS,
  ): Promise<{ aborted: boolean; settled: boolean }> {
    const pending: Promise<void>[] = [];
    for (const r of this.active.values()) {
      if (r.threadId === threadId) {
        r.abort();
        pending.push(r.ended);
      }
    }
    if (!pending.length) return { aborted: false, settled: true };
    return { aborted: true, settled: await settledWithin(pending, timeoutMs) };
  }

  /**
   * `DELETE /threads/:id`: stops the thread's run (bounded wait, like `abortThread`) with the
   * thread marked as being deleted, so the run ending does not send a queued message into a
   * thread that is about to disappear. Call `deleted` once the row is gone (or the delete failed).
   */
  async abortForDelete(threadId: string): Promise<{ aborted: boolean; settled: boolean }> {
    this.deletingThreads.add(threadId);
    return this.abortThread(threadId);
  }

  deleted(threadId: string): void {
    this.deletingThreads.delete(threadId);
    for (const waiting of this.waitingOnProject.values()) waiting.delete(threadId);
  }

  abortAll(): void {
    for (const r of this.active.values()) r.abort();
  }

  async settleAll(timeoutMs = 1_000): Promise<boolean> {
    return settledWithin(
      [...this.active.values()].map((run) => run.done),
      timeoutMs,
    );
  }

  /* ---------- supervised mode: pending requests ---------- */

  /** Requests still waiting on a human for this thread, oldest first. */
  pending(threadId: string): PendingRequests {
    const approvals: ApprovalRequestedEvent[] = [];
    const inputs: InputRequestedEvent[] = [];
    for (const run of this.active.values()) {
      if (run.threadId !== threadId) continue;
      for (const p of run.pending.values()) {
        if (p.kind === "approval") approvals.push(p.event);
        else inputs.push(p.event);
      }
    }
    const byTs = (a: { ts: number }, b: { ts: number }) => a.ts - b.ts;
    return { approvals: approvals.sort(byTs), inputs: inputs.sort(byTs) };
  }

  /** `ok`, `not_found` (no such pending request on that thread) or `resolved` (already settled). */
  resolveApproval(
    threadId: string,
    requestId: string,
    decision: ApprovalDecision,
    by: ApprovalResolvedBy,
  ): "ok" | "not_found" | "resolved" {
    const found = this.findPending(threadId, requestId);
    if (!found)
      return this.wasRequested(threadId, requestId, "approval") ? "resolved" : "not_found";
    if (found.kind !== "approval") return "not_found";
    found.resolve(decision, by);
    return "ok";
  }

  resolveInput(
    threadId: string,
    requestId: string,
    answer: string,
  ): "ok" | "not_found" | "resolved" {
    const found = this.findPending(threadId, requestId);
    if (!found)
      return this.wasRequested(threadId, requestId, "question") ? "resolved" : "not_found";
    if (found.kind !== "input") return "not_found";
    found.resolve(answer);
    return "ok";
  }

  private findPending(threadId: string, requestId: string): Pending | null {
    for (const run of this.active.values()) {
      if (run.threadId !== threadId) continue;
      const p = run.pending.get(requestId);
      if (p) return p;
    }
    return null;
  }

  /** A settled request still has its part in the thread's messages; that is what tells 409 from 404. */
  private wasRequested(
    threadId: string,
    requestId: string,
    type: "approval" | "question",
  ): boolean {
    return this.deps.store.threads
      .messages(threadId)
      .some((m) => m.parts.some((p) => p.type === type && p.requestId === requestId));
  }

  /**
   * Pauses the run until someone decides. The part goes into the assistant message first so a
   * client that loads the thread sees the pending card; the event follows for the ones already
   * connected. Every path — a decision, the timeout, the run ending — settles the promise exactly
   * once.
   */
  requestApproval(
    run: ActiveRun,
    req: { tool: string; input: unknown; summary: string },
  ): Promise<ApprovalDecision> {
    const requestId = newId("apr");
    const event: ApprovalRequestedEvent = {
      ts: Date.now(),
      topic: "agent.approval_requested",
      runId: run.runId,
      threadId: run.threadId,
      requestId,
      tool: req.tool,
      input: req.input,
      summary: req.summary,
    };
    const part: ApprovalPart = {
      type: "approval",
      requestId,
      tool: req.tool,
      input: req.input,
      summary: req.summary,
      decision: "pending",
    };
    run.addPart(part);
    return new Promise<ApprovalDecision>((resolve) => {
      const settle = (decision: ApprovalDecision, by: ApprovalResolvedBy) => {
        const entry = run.pending.get(requestId);
        if (!entry) return;
        clearTimeout(entry.timer);
        run.pending.delete(requestId);
        run.patchPart(requestId, (p) => (p.type === "approval" ? { ...p, decision, by } : p));
        this.deps.emit({
          ts: Date.now(),
          topic: "agent.approval_resolved",
          runId: run.runId,
          threadId: run.threadId,
          requestId,
          decision,
          by,
        });
        this.deps.emit({ ts: Date.now(), topic: "thread.updated", threadId: run.threadId });
        resolve(decision);
      };
      const timer = setTimeout(
        () => settle("deny", "timeout"),
        this.deps.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS,
      );
      if (typeof timer === "object" && "unref" in timer) timer.unref();
      run.pending.set(requestId, { kind: "approval", event, resolve: settle, timer });
      this.deps.emit(event);
      this.deps.emit({ ts: Date.now(), topic: "thread.updated", threadId: run.threadId });
    });
  }

  /** Like `requestApproval`; an unanswered question resolves with an empty answer after the timeout. */
  requestInput(
    run: ActiveRun,
    req: { question: string; options?: string[] },
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted || run.stopping) return Promise.resolve("");
    const requestId = newId("ask");
    const event: InputRequestedEvent = {
      ts: Date.now(),
      topic: "agent.input_requested",
      runId: run.runId,
      threadId: run.threadId,
      requestId,
      question: req.question,
      ...(req.options ? { options: req.options } : {}),
    };
    const part: QuestionPart = {
      type: "question",
      requestId,
      question: req.question,
      ...(req.options ? { options: req.options } : {}),
      answer: null,
    };
    run.addPart(part);
    return new Promise<string>((resolve) => {
      const settle = (answer: string) => {
        const entry = run.pending.get(requestId);
        if (!entry) return;
        clearTimeout(entry.timer);
        signal?.removeEventListener("abort", cancel);
        run.pending.delete(requestId);
        run.patchPart(requestId, (p) => (p.type === "question" ? { ...p, answer } : p));
        this.deps.emit({
          ts: Date.now(),
          topic: "agent.input_resolved",
          runId: run.runId,
          threadId: run.threadId,
          requestId,
          answer,
        });
        this.deps.emit({ ts: Date.now(), topic: "thread.updated", threadId: run.threadId });
        resolve(answer);
      };
      const cancel = () => settle("");
      const timer = setTimeout(
        () => settle(""),
        this.deps.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS,
      );
      if (typeof timer === "object" && "unref" in timer) timer.unref();
      run.pending.set(requestId, { kind: "input", event, resolve: settle, timer });
      signal?.addEventListener("abort", cancel, { once: true });
      this.deps.emit(event);
      this.deps.emit({ ts: Date.now(), topic: "thread.updated", threadId: run.threadId });
    });
  }

  /**
   * Claude Code's permission prompt, served as the MCP tool `permission_prompt`: the run token in
   * the call's bearer identifies the run. Reads and idempotent fabdesk tools are allowed on the
   * spot; writes wait for a decision; `AskUserQuestion` becomes one `input_requested` per question
   * and is answered through `updatedInput.answers` (keyed by question text, as Claude expects).
   */
  async permissionPrompt(
    token: string | null,
    req: { toolName: string; input: unknown; toolUseId?: string },
  ): Promise<PermissionPromptResult> {
    const info = this.deps.tokens.lookup(token);
    const run = info?.kind === "run" && info.runId ? this.active.get(info.runId) : undefined;
    if (!run)
      return { behavior: "deny", message: "permission prompt from an unknown or finished run" };
    if (req.toolName === "AskUserQuestion") {
      const questions = parseAskUserQuestion(req.input);
      if (!questions) return { behavior: "deny", message: "AskUserQuestion without questions" };
      const answers: Record<string, string> = {};
      for (const q of questions) {
        const answer = await this.requestInput(run, {
          question: q.question,
          ...(q.options ? { options: q.options.map((o) => o.label) } : {}),
        });
        if (answer === "") return { behavior: "deny", message: "the user did not answer" };
        answers[q.question] = answer;
      }
      const base =
        typeof req.input === "object" && req.input !== null
          ? (req.input as Record<string, unknown>)
          : {};
      return { behavior: "allow", updatedInput: { ...base, answers } };
    }
    const cls = classifyToolCall(
      req.toolName,
      req.input,
      this.deps.annotationsFor ?? (() => undefined),
    );
    if (!cls.needsApproval || run.runtimeMode !== "supervised")
      return { behavior: "allow", updatedInput: req.input };
    const decision = await this.requestApproval(run, {
      tool: req.toolName,
      input: req.input,
      summary: cls.summary,
    });
    return decision === "approve"
      ? { behavior: "allow", updatedInput: req.input }
      : {
          behavior: "deny",
          message:
            "The user denied this tool call. Do not retry it; ask or choose another approach.",
        };
  }

  /* ---------- runs ---------- */

  /**
   * Starts a run. Refused (412) while the thread has a run, or while another thread's run holds
   * the project. Both checks and the reservation happen before the first await, so concurrent
   * requests cannot both get through; the reservation becomes the run's `active` entry and is
   * dropped on every exit from here.
   */
  async start(input: StartInput): Promise<{ runId: string; messageId: string }> {
    // The adapter resolves its CLI on PATH; a message sent right after startup must not beat the
    // login-shell lookup (bounded, and already settled in every later call).
    await userPathReady();
    if (this.deletingThreads.has(input.threadId))
      throw new ToolError("the thread is being deleted", "not_found");
    if (this.isRunning(input.threadId))
      throw new ToolError("an agent run is already active on this thread", "precondition");
    const projectId = input.project?.id ?? null;
    if (projectId && this.deps.projectTransitioning?.(projectId)) throw new ToolError("Project setup is in progress. Send again once it finishes.", "precondition");
    if (input.workspaceContext && input.workspaceContext.projectId !== projectId) throw new ToolError("Workspace context belongs to another project. Reopen the conversation and send again.", "precondition");
    const busy = projectId !== null ? this.projectBusyMessage(projectId) : null;
    if (busy) throw new ToolError(busy.message, "precondition");
    this.startingThreads.add(input.threadId);
    if (projectId !== null) this.startingProjects.set(projectId, input.threadId);
    try {
      return await this.startReserved(input);
    } finally {
      this.startingThreads.delete(input.threadId);
      if (projectId !== null) this.startingProjects.delete(projectId);
    }
  }

  private async startReserved(input: StartInput): Promise<{ runId: string; messageId: string }> {
    const { store, emit, tokens } = this.deps;
    const adapter = this.deps.adapters[input.agentId];
    if (!adapter) throw new ToolError(`agent ${input.agentId} is not available`, "unavailable");
    const settings = this.deps.settings();
    const agentSettings = settings.agents[input.agentId];
    const planningOnly = !!input.project?.manifest().ideaDraft;
    if (planningOnly && !["codex", "claude"].includes(input.agentId)) throw new ToolError("Draft discussion is available with Codex or Claude. Choose one, or create the project first.", "precondition");
    const runtimeMode: RuntimeMode = store.threads.get(input.threadId)?.runtimeMode ?? "full";
    if (runtimeMode === "supervised" && !adapter.supportsSupervised)
      throw new ToolError("agent cannot run supervised", "invalid_args");
    const cwd = input.project?.dir ?? join(this.deps.workspaceDir, "scratch", input.threadId);
    await mkdir(cwd, { recursive: true });
    if (input.project && !planningOnly && this.deps.prepareProject)
      await this.deps
        .prepareProject(input.project, input.agentId)
        .catch((e) => logger.warn("prepareProject failed", { error: errMsg(e) }));

    const selectedModel = input.model ?? agentSettings?.model;
    const capabilities = agentSettings?.effort
      ? await adapter.detect?.(agentSettings.binaryPath ?? undefined) : undefined;
    const effortModel = selectedModel || capabilities?.defaultModel;
    // A remembered preference must not force an unsupported level after a model switch.
    const effort = effortModel && agentSettings?.effort && capabilities?.modelEfforts?.[effortModel]?.includes(agentSettings.effort)
      ? agentSettings.effort : undefined;
    const run = store.runs.create({ threadId: input.threadId, agentId: input.agentId });
    let agentTrace: AgentTrace | undefined;
    try {
      agentTrace = await this.deps.telemetry?.startAgentRun({
        runId: run.id,
        threadId: input.threadId,
        agentId: input.agentId,
        projectId: input.project?.id ?? null,
        cwd,
        prompt: workspacePrompt(input.prompt, input.workspaceContext),
        attachments: input.attachments,
        ...(selectedModel ? { model: selectedModel } : {}),
      });
      if (agentTrace) store.runs.setLogPath(run.id, agentTrace.logPath);
    } catch (e) {
      logger.warn("agent trace could not be started", { runId: run.id, error: errMsg(e) });
    }
    const finishTrace = async (
      status: "completed" | "aborted" | "failed",
      details: Record<string, unknown>,
    ) => {
      await agentTrace
        ?.finish(status, details)
        .catch((e) =>
          logger.warn("agent trace could not be finished", { runId: run.id, error: errMsg(e) }),
        );
    };
    const token = tokens.mintRunToken({
      runId: run.id,
      projectId: input.project?.id ?? null,
      threadId: input.threadId,
    });
    const promotedAt = input.project?.manifest().promotedAt;
    const previousSession = store.runs.historyForThread(input.threadId).find(item => item.agentId === input.agentId && item.agentSessionId);
    // The old session's cwd and restrictions belong to the draft; carry conversation text
    // into a fresh session once after promotion instead of resuming the old directory.
    const resume = previousSession && (!promotedAt || previousSession.startedAt >= promotedAt) ? previousSession.agentSessionId : null;
    const history = !resume && promotedAt ? store.threads.messages(input.threadId).filter(item => item.role === "user" || item.role === "assistant").map(item => `${item.role}: ${item.contentMd}`).join("\n\n") : "";
    const planningInstructions = "You are helping explore an idea draft in fabPlane. Discuss requirements, explain options and use attached sketches as planning references. Do not create, edit, generate, render or validate engineering files. If the user asks for those actions, call request_project_creation with their agreed request, then stop and explain that project setup is ready. Do not use a shell or another tool to work around the draft boundary. Do not claim a board or schematic exists. Use request_user_input for planning questions when available; an unanswered question is not approval.\n\n";
    const message = store.threads.addMessage({
      threadId: input.threadId,
      role: "assistant",
      contentMd: "",
      parts: [],
      runId: run.id,
    });
    const parts: MessagePart[] = [];
    let contentMd = "";
    let lastPersist = 0;
    const persist = (force = false) => {
      const now = Date.now();
      if (!force && now - lastPersist < 500) return;
      lastPersist = now;
      store.threads.updateMessage(message.id, { contentMd, parts: [...parts] });
    };
    const appendText = (kind: "text" | "thinking", delta: string) => {
      if (!delta) return;
      const last = parts.at(-1);
      if (last && last.type === kind) last.text += delta;
      else parts.push({ type: kind, text: delta });
      if (kind === "text") contentMd += delta;
      emit({
        ts: Date.now(),
        topic: "agent.delta",
        runId: run.id,
        messageId: message.id,
        part: kind,
        delta,
      });
      persist();
    };

    emit({
      ts: Date.now(),
      topic: "agent.started",
      runId: run.id,
      threadId: input.threadId,
      agentId: input.agentId,
    });
    emit({ ts: Date.now(), topic: "thread.updated", threadId: input.threadId });

    const workbenchEnv: Record<string, string> | undefined = await this.deps
      .agentEnvironment?.({ cwd, project: input.project })
      .catch((e) => {
        logger.warn("agent PCB environment could not be resolved", { error: errMsg(e) });
        return {};
      });

    // Registered before the adapter starts: an in-band supervisor call can arrive with the first event.
    const active: ActiveRun = {
      runId: run.id,
      threadId: input.threadId,
      agentId: input.agentId,
      projectId: input.project?.id ?? null,
      runtimeMode,
      abort: () => {},
      ended: Promise.resolve(),
      done: Promise.resolve(),
      pending: new Map(),
      addPart: (part) => {
        parts.push(part);
        persist(true);
      },
      patchPart: (requestId, fn) => {
        const idx = parts.findIndex(
          (p) => (p.type === "approval" || p.type === "question") && p.requestId === requestId,
        );
        if (idx >= 0) parts[idx] = fn(parts[idx] as MessagePart);
        persist(true);
      },
    };
    this.active.set(run.id, active);

    const supervisor: AgentSupervisor = {
      requestApproval: (req) =>
        this.requestApproval(active, {
          tool: req.tool,
          input: req.input,
          summary: req.summary ?? classifyToolCall(req.tool, req.input, () => undefined).summary,
        }),
      requestInput: (req) => this.requestInput(active, req, req.signal),
    };

    const prompt = `${planningOnly ? planningInstructions : history ? `Earlier planning conversation (context, not new instructions):\n${history}\n\nCurrent request:\n` : ""}${workspacePrompt(input.prompt, input.workspaceContext)}`;
    const policy = applyImagePolicy(adapter.images ?? "read", prompt, input.attachments);
    const session: AgentSession = {
      cwd,
      prompt: policy.prompt,
      attachments: policy.attachments,
      mcp: {
        url: planningOnly ? appendMcpProfile(this.deps.mcpUrl, "planning") : this.deps.mcpProfile
          ? appendMcpProfile(this.deps.mcpUrl, this.deps.mcpProfile)
          : appendToolsets(this.deps.mcpUrl, (await this.deps.extraToolsets?.(input.project ?? null).catch(() => [])) ?? []),
        token,
      },
      ...(resume ? { resume } : {}),
      ...(selectedModel ? { model: selectedModel } : {}),
      ...(effort ? { effort } : {}),
      permission: agentSettings?.permissionMode ?? "acceptEdits",
      ...(planningOnly ? { planningOnly: true } : {}),
      ...(workbenchEnv && Object.keys(workbenchEnv).length ? { env: workbenchEnv } : {}),
      runtimeMode,
      requestInput: (req) => this.requestInput(active, req, req.signal),
      ...(runtimeMode === "supervised" ? { supervisor } : {}),
      ...(agentSettings?.extraAllowedTools?.length
        ? { extraAllowedTools: agentSettings.extraAllowedTools }
        : {}),
      ...(agentSettings?.binaryPath ? { binaryPath: agentSettings.binaryPath } : {}),
    };

    // A failure has to be visible in the chat, not only on the event bus: after a reload the message is all
    // the user has, and an empty assistant turn looks like the agent simply never answered.
    const reportedErrors = new Set<string>();
    const recordError = (message: string) => {
      const normalized = message.trim();
      if (reportedErrors.has(normalized)) return;
      reportedErrors.add(normalized);
      // Some CLIs emit the same failure first as text, then as a result error.
      if (parts.some((p) => p.type === "text" && p.text.trim() === normalized)) {
        persist(true);
        return;
      }
      appendText("text", `${contentMd.length || parts.length ? "\n\n" : ""}⚠ ${message}`);
      persist(true);
    };

    let handle: AgentRun;
    try {
      handle = adapter.run(session);
    } catch (e) {
      const msg = errMsg(e);
      captureCoreException(e, { agent: input.agentId, "agent.phase": "start" });
      recordError(`${input.agentId} could not be started: ${msg}`);
      store.runs.finish(run.id, { status: "failed" });
      tokens.revokeRun(run.id);
      this.active.delete(run.id);
      emit({ ts: Date.now(), topic: "agent.error", runId: run.id, message: msg });
      await finishTrace("failed", { phase: "start", error: msg });
      emit({
        ts: Date.now(),
        topic: "agent.done",
        runId: run.id,
        threadId: input.threadId,
        status: "failed",
      });
      throw new ToolError(`failed to start ${input.agentId}: ${msg}`, "unavailable");
    }

    let aborted = false;
    const consume = async () => {
      let status: "completed" | "aborted" | "failed" = "completed";
      let exitCode: number | undefined;
      let sessionId: string | undefined;
      const cost: Record<string, number> = {};
      try {
        for await (const ev of handle.events) {
          agentTrace?.record(`agent.${ev.type}`, ev);
          switch (ev.type) {
            case "init": {
              if (ev.sessionId) {
                sessionId = ev.sessionId;
                store.runs.setSession(run.id, ev.sessionId);
              }
              const failed = (ev.mcpServers ?? []).filter((s) => s.status !== "connected");
              if (failed.length)
                emit({
                  ts: Date.now(),
                  topic: "agent.error",
                  runId: run.id,
                  message: `MCP server(s) not connected: ${failed.map((s) => `${s.name}=${s.status}`).join(", ")}`,
                });
              break;
            }
            case "text":
              appendText("text", ev.delta);
              break;
            case "thinking":
              appendText("thinking", ev.delta);
              break;
            case "tool_use":
              parts.push({ type: "tool_use", id: ev.id, name: ev.name, input: ev.input });
              emit({
                ts: Date.now(),
                topic: "agent.tool_use",
                runId: run.id,
                messageId: message.id,
                id: ev.id,
                name: ev.name,
                input: ev.input,
              });
              persist(true);
              break;
            case "tool_result": {
              // Persist source classification for native image inspection, including providers that
              // do not return MCP metadata. The original model-facing payload is unchanged.
              const use = parts.find(part => part.type === "tool_use" && part.id === ev.id);
              const name = use?.type === "tool_use" ? use.name.replace(/^mcp__.+?__/, "").replace(/^functions\./, "") : "";
              const inspection = ["view_image", "image_view", "open_image"].includes(name);
              const output = inspection ? { _imagePresentation: "inspection", result: ev.output } : ev.output;
              parts.push({
                type: "tool_result",
                id: ev.id,
                output,
                ...(ev.isError !== undefined ? { isError: ev.isError } : {}),
              });
              emit({
                ts: Date.now(),
                topic: "agent.tool_result",
                runId: run.id,
                messageId: message.id,
                id: ev.id,
                output,
                ...(ev.isError !== undefined ? { isError: ev.isError } : {}),
              });
              persist(true);
              break;
            }
            case "usage":
              if (ev.inputTokens !== undefined)
                cost["inputTokens"] = (cost["inputTokens"] ?? 0) + ev.inputTokens;
              if (ev.outputTokens !== undefined)
                cost["outputTokens"] = (cost["outputTokens"] ?? 0) + ev.outputTokens;
              if (ev.costUsd !== undefined) cost["costUsd"] = (cost["costUsd"] ?? 0) + ev.costUsd;
              emit({
                ts: Date.now(),
                topic: "agent.usage",
                runId: run.id,
                ...(ev.inputTokens !== undefined ? { inputTokens: ev.inputTokens } : {}),
                ...(ev.outputTokens !== undefined ? { outputTokens: ev.outputTokens } : {}),
                ...(ev.costUsd !== undefined ? { costUsd: ev.costUsd } : {}),
              });
              break;
            case "error":
              emit({ ts: Date.now(), topic: "agent.error", runId: run.id, message: ev.message });
              if (!aborted) {
                status = "failed";
                recordError(ev.message);
              }
              break;
            case "done":
              exitCode = ev.exitCode;
              if (ev.sessionId) {
                sessionId = ev.sessionId;
                store.runs.setSession(run.id, ev.sessionId);
              }
              if (aborted) status = "aborted";
              else if (exitCode !== 0) status = "failed";
              break;
          }
        }
      } catch (e) {
        if (!aborted) {
          status = "failed";
          agentTrace?.record("agent.stream_error", { error: e });
          captureCoreException(e, { agent: input.agentId, "agent.phase": "stream" });
          emit({ ts: Date.now(), topic: "agent.error", runId: run.id, message: errMsg(e) });
          recordError(errMsg(e));
        }
      }
      if (aborted) status = "aborted";
      // A non-zero exit with no explanation so far (the CLI printed plain text instead of JSONL, e.g.
      // "Not logged in") still has to say something in the chat.
      if (status === "failed" && reportedErrors.size === 0) {
        recordError(
          `${input.agentId} exited with code ${exitCode ?? "unknown"} without producing a reply. Check that it is installed and signed in (run it once in a terminal), then send the message again.`,
        );
      }
      // The agent is gone, so nothing can act on an answer any more: settle what is still pending
      // (a deny, attributed to the timeout) rather than leave cards spinning forever.
      for (const p of [...active.pending.values()]) {
        if (p.kind === "approval") p.resolve("deny", "timeout");
        else p.resolve("");
      }
      persist(true);
      store.runs.finish(run.id, { status, exitCode: exitCode ?? null, cost });
      tokens.revokeRun(run.id);
      store.threads.touch(input.threadId);
      await finishTrace(status, {
        ...(sessionId ? { sessionId } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
        cost,
      });
      emit({
        ts: Date.now(),
        topic: "agent.done",
        runId: run.id,
        threadId: input.threadId,
        status,
        ...(sessionId ? { sessionId } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
      });
      emit({ ts: Date.now(), topic: "thread.updated", threadId: input.threadId });
    };
    // Whatever happens while winding the run down, it leaves `active` — that is what releases the
    // thread and the project lease — before the next queued message is sent.
    const ended = consume()
      .catch((e) => {
        logger.error("agent run bookkeeping failed", { runId: run.id, error: errMsg(e) });
        captureCoreException(e, { agent: input.agentId, "agent.phase": "finish" });
        tokens.revokeRun(run.id);
        try {
          store.runs.finish(run.id, { status: "failed" });
        } catch {
          /* the run row stays `running` until the next daemon start fails it */
        }
      })
      .finally(() => {
        this.active.delete(run.id);
      });
    const projectId = input.project?.id ?? null;
    const done = ended
      .then(() => this.drainQueue(input.threadId))
      .then(() => (projectId !== null ? this.drainWaiting(projectId) : undefined))
      .catch((e) => logger.warn("post-run drain failed", { runId: run.id, error: errMsg(e) }));

    active.abort = () => {
      aborted = true;
      active.stopping = true;
      for (const pending of active.pending.values()) {
        if (pending.kind === "input") pending.resolve("");
      }
      try {
        handle.abort();
      } catch (e) {
        logger.warn("abort failed", { error: errMsg(e) });
      }
    };
    active.ended = ended;
    active.done = done;
    return { runId: run.id, messageId: message.id };
  }

  /* ---------- queued messages (C5) ---------- */

  /**
   * Sends the oldest message queued while the run was live. The message row already exists (it
   * was created when queued, so it sorts after the assistant turn it waited for); it only loses
   * its `queued` status and starts a run. A failure to start is written into the thread the same
   * way any run failure is, and the next queued message waits for the next run to end.
   */
  async drainQueue(threadId: string): Promise<void> {
    const { store, emit } = this.deps;
    try {
      const queued = () =>
        this.deletingThreads.has(threadId) ||
        !store.threads.get(threadId) ||
        this.isRunning(threadId)
          ? undefined
          : store.threads.messages(threadId).find((m) => m.status === "queued");
      const first = store.threads.get(threadId);
      if (!first || !queued()) return;
      // Resolved before the message leaves the queue: everything from the checks below to the
      // lease `start` reserves is synchronous, so another thread cannot take the project between.
      const project =
        first.projectId && this.deps.resolveProject
          ? await this.deps.resolveProject(first.projectId)
          : null;
      const thread = store.threads.get(threadId);
      const next = queued();
      if (!thread || !next) return;
      if (project && this.projectHolder(project.id) !== null) {
        // Another thread's run writes the project: the message stays queued and goes out when
        // that run ends (see `drainWaiting`).
        this.waitForProject(project.id, threadId);
        return;
      }
      store.threads.updateMessage(next.id, { status: null });
      emit({ ts: Date.now(), topic: "thread.updated", threadId });
      const attachments = attachmentsFromImageParts(next.parts);
      try {
        const context = next.parts.find(part => part.type === "workspace_context");
        if (context?.type === "workspace_context" && context.context.projectId !== (project?.id ?? null)) throw new ToolError("The queued workspace context belongs to another project. Review this message before sending it again.", "precondition");
        await this.start({
          threadId,
          project,
          agentId: thread.agentId,
          ...(thread.model ? { model: thread.model } : {}),
          prompt: next.contentMd,
          ...(context?.type === "workspace_context" ? { workspaceContext: context.context } : {}),
          attachments,
        });
      } catch (e) {
        logger.warn("queued message could not be sent", { threadId, error: errMsg(e) });
        if (!store.threads.get(threadId)) return;
        if (e instanceof ToolError && e.code === "precondition" && project) {
          // Lost the project after all: back in the queue rather than dropped without a reply.
          store.threads.updateMessage(next.id, { status: "queued" });
          this.waitForProject(project.id, threadId);
        } else {
          store.threads.addMessage({
            threadId,
            role: "system",
            contentMd: `⚠ Queued message could not be sent: ${errMsg(e)}`,
          });
        }
        emit({ ts: Date.now(), topic: "thread.updated", threadId });
      }
    } catch (e) {
      // A drain runs detached from any request (after a run ends): it must never reject.
      logger.warn("queued message drain failed", { threadId, error: errMsg(e) });
    }
  }

  private waitForProject(projectId: string, threadId: string): void {
    const waiting = this.waitingOnProject.get(projectId) ?? new Set<string>();
    waiting.add(threadId);
    this.waitingOnProject.set(projectId, waiting);
  }

  /** After a run on `projectId` ends: the threads whose queued message waited for the project. */
  private async drainWaiting(projectId: string): Promise<void> {
    const waiting = this.waitingOnProject.get(projectId);
    if (!waiting) return;
    this.waitingOnProject.delete(projectId);
    // The first to start takes the lease; the rest find it busy and wait again.
    for (const threadId of waiting) await this.drainQueue(threadId);
  }
}
