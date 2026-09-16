/**
 * Agent runs: spawn an agent adapter for a thread message, map AgentEvents to `agent.*` bus events
 * and persist the assistant message parts as they stream. Also the home of supervised mode's
 * pending requests (approvals and questions) and of the queued-message drain that runs when a
 * run ends.
 */
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
import type { AgentTrace, RunTelemetry } from "./run-telemetry";

import type {
  AgentAdapter,
  AgentEvent,
  AgentRun,
  AgentSession,
  AgentSupervisor,
} from "@fabdesk/agents";

export type AgentAdapterLike = Pick<AgentAdapter, "id" | "run"> & { supportsSupervised?: boolean };

/** A request nobody answered for this long resolves as `deny` with `by: "timeout"`. */
export const APPROVAL_TIMEOUT_MS = 30 * 60_000;

function appendMcpProfile(url: string, profile: "substrate"): string {
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
  /** Tests shorten the 30-minute approval timeout. */
  approvalTimeoutMs?: number;
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
  runtimeMode: RuntimeMode;
  abort(): void;
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

export class AgentRunManager {
  private readonly active = new Map<string, ActiveRun>();
  constructor(private readonly deps: RunDeps) {}

  isRunning(threadId: string): boolean {
    return [...this.active.values()].some((r) => r.threadId === threadId);
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

  abortThread(threadId: string): boolean {
    let hit = false;
    for (const r of this.active.values()) {
      if (r.threadId === threadId) {
        r.abort();
        hit = true;
      }
    }
    return hit;
  }

  abortAll(): void {
    for (const r of this.active.values()) r.abort();
  }

  async settleAll(timeoutMs = 1_000): Promise<boolean> {
    const pending = [...this.active.values()].map((run) => run.done);
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
  requestInput(run: ActiveRun, req: { question: string; options?: string[] }): Promise<string> {
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
      const timer = setTimeout(
        () => settle(""),
        this.deps.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS,
      );
      if (typeof timer === "object" && "unref" in timer) timer.unref();
      run.pending.set(requestId, { kind: "input", event, resolve: settle, timer });
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

  async start(input: {
    threadId: string;
    project: ProjectHandle | null;
    agentId: AgentId;
    model?: string;
    prompt: string;
    attachments: Array<{ path: string; mime: string }>;
  }): Promise<{ runId: string; messageId: string }> {
    const { store, emit, tokens } = this.deps;
    if (this.isRunning(input.threadId))
      throw new ToolError("an agent run is already active on this thread", "precondition");
    const adapter = this.deps.adapters[input.agentId];
    if (!adapter) throw new ToolError(`agent ${input.agentId} is not available`, "unavailable");
    const settings = this.deps.settings();
    const agentSettings = settings.agents[input.agentId];
    const runtimeMode: RuntimeMode = store.threads.get(input.threadId)?.runtimeMode ?? "full";
    if (runtimeMode === "supervised" && !adapter.supportsSupervised)
      throw new ToolError("agent cannot run supervised", "invalid_args");
    const cwd = input.project?.dir ?? join(this.deps.workspaceDir, "scratch", input.threadId);
    await mkdir(cwd, { recursive: true });
    if (input.project && this.deps.prepareProject)
      await this.deps
        .prepareProject(input.project, input.agentId)
        .catch((e) => logger.warn("prepareProject failed", { error: errMsg(e) }));

    const run = store.runs.create({ threadId: input.threadId, agentId: input.agentId });
    const selectedModel = input.model ?? agentSettings?.model;
    let agentTrace: AgentTrace | undefined;
    try {
      agentTrace = await this.deps.telemetry?.startAgentRun({
        runId: run.id,
        threadId: input.threadId,
        agentId: input.agentId,
        projectId: input.project?.id ?? null,
        cwd,
        prompt: input.prompt,
        attachments: input.attachments,
        ...(selectedModel ? { model: selectedModel } : {}),
      });
      if (agentTrace) store.runs.setLogPath(run.id, agentTrace.logPath);
    } catch (e) {
      logger.warn("agent trace could not be started", { runId: run.id, error: errMsg(e) });
    }
    const finishTrace = (
      status: "completed" | "aborted" | "failed",
      details: Record<string, unknown>,
    ) => {
      void agentTrace
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
    const resume = store.runs.lastSession(input.threadId, input.agentId);
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

    const workbenchEnv = await this.deps
      .agentEnvironment?.({ cwd, project: input.project })
      .catch((e) => {
        logger.warn("agent PCB environment could not be resolved", { error: errMsg(e) });
        return {};
      });

    // Registered before the adapter starts: an in-band supervisor call can arrive with the first event.
    const active: ActiveRun = {
      runId: run.id,
      threadId: input.threadId,
      runtimeMode,
      abort: () => {},
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
      requestInput: (req) => this.requestInput(active, req),
    };

    const session: AgentSession = {
      cwd,
      prompt: input.prompt,
      attachments: input.attachments,
      mcp: {
        url: this.deps.mcpProfile
          ? appendMcpProfile(this.deps.mcpUrl, this.deps.mcpProfile)
          : this.deps.mcpUrl,
        token,
      },
      ...(resume ? { resume } : {}),
      ...(selectedModel ? { model: selectedModel } : {}),
      permission: agentSettings?.permissionMode ?? "acceptEdits",
      ...(workbenchEnv && Object.keys(workbenchEnv).length ? { env: workbenchEnv } : {}),
      runtimeMode,
      ...(runtimeMode === "supervised" ? { supervisor } : {}),
      ...(agentSettings?.extraAllowedTools?.length
        ? { extraAllowedTools: agentSettings.extraAllowedTools }
        : {}),
      ...(agentSettings?.binaryPath ? { binaryPath: agentSettings.binaryPath } : {}),
    };

    // A failure has to be visible in the chat, not only on the event bus: after a reload the message is all
    // the user has, and an empty assistant turn looks like the agent simply never answered.
    const recordError = (message: string) => {
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
      finishTrace("failed", { phase: "start", error: msg });
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
    const done = (async () => {
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
            case "tool_result":
              parts.push({
                type: "tool_result",
                id: ev.id,
                output: ev.output,
                ...(ev.isError !== undefined ? { isError: ev.isError } : {}),
              });
              emit({
                ts: Date.now(),
                topic: "agent.tool_result",
                runId: run.id,
                messageId: message.id,
                id: ev.id,
                output: ev.output,
                ...(ev.isError !== undefined ? { isError: ev.isError } : {}),
              });
              persist(true);
              break;
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
      if (status === "failed" && !parts.some((p) => p.type === "text" && p.text.includes("⚠"))) {
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
      finishTrace(status, {
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
      this.active.delete(run.id);
      await this.drainQueue(input.threadId);
    })();

    active.abort = () => {
      aborted = true;
      try {
        handle.abort();
      } catch (e) {
        logger.warn("abort failed", { error: errMsg(e) });
      }
    };
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
    const thread = store.threads.get(threadId);
    if (!thread || this.isRunning(threadId)) return;
    const next = store.threads.messages(threadId).find((m) => m.status === "queued");
    if (!next) return;
    store.threads.updateMessage(next.id, { status: null });
    emit({ ts: Date.now(), topic: "thread.updated", threadId });
    const attachments = next.parts.flatMap((p) =>
      p.type === "image" ? [{ path: p.path, mime: p.mime }] : [],
    );
    try {
      const project =
        thread.projectId && this.deps.resolveProject
          ? await this.deps.resolveProject(thread.projectId)
          : null;
      await this.start({
        threadId,
        project,
        agentId: thread.agentId,
        ...(thread.model ? { model: thread.model } : {}),
        prompt: next.contentMd,
        attachments,
      });
    } catch (e) {
      logger.warn("queued message could not be sent", { threadId, error: errMsg(e) });
      store.threads.addMessage({
        threadId,
        role: "system",
        contentMd: `⚠ Queued message could not be sent: ${errMsg(e)}`,
      });
      emit({ ts: Date.now(), topic: "thread.updated", threadId });
    }
  }
}
