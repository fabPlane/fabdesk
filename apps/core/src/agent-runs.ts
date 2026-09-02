/**
 * Agent runs: spawn an agent adapter for a thread message, map AgentEvents to `agent.*` bus events
 * and persist the assistant message parts as they stream.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentId, CoreEvent, MessagePart, Settings } from "@fabdesk/protocol";
import { ToolError, type ProjectHandle } from "@fabdesk/tools";
import type { Store } from "./db";
import { logger, errMsg } from "./log";
import type { TokenSet } from "./auth";

import type { AgentAdapter, AgentEvent, AgentRun, AgentSession } from "@fabdesk/agents";

export type AgentAdapterLike = Pick<AgentAdapter, "id" | "run">;

export type RunDeps = {
  store: Store;
  emit: (e: CoreEvent) => void;
  tokens: TokenSet;
  mcpUrl: string;
  adapters: Partial<Record<AgentId, AgentAdapterLike>>;
  settings: () => Settings;
  /** Regenerates AGENTS.md/CLAUDE.md before the run. */
  prepareProject?: (project: ProjectHandle, agentId: AgentId) => Promise<void>;
  workspaceDir: string;
};

export type ActiveRun = { runId: string; threadId: string; abort(): void; done: Promise<void> };

export class AgentRunManager {
  private readonly active = new Map<string, ActiveRun>();
  constructor(private readonly deps: RunDeps) {}

  isRunning(threadId: string): boolean {
    return [...this.active.values()].some((r) => r.threadId === threadId);
  }

  activeCount(): number {
    return this.active.size;
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

  async start(input: { threadId: string; project: ProjectHandle | null; agentId: AgentId; model?: string; prompt: string; attachments: Array<{ path: string; mime: string }> }): Promise<{ runId: string; messageId: string }> {
    const { store, emit, tokens } = this.deps;
    if (this.isRunning(input.threadId)) throw new ToolError("an agent run is already active on this thread", "precondition");
    const adapter = this.deps.adapters[input.agentId];
    if (!adapter) throw new ToolError(`agent ${input.agentId} is not available`, "unavailable");
    const settings = this.deps.settings();
    const agentSettings = settings.agents[input.agentId];
    const cwd = input.project?.dir ?? join(this.deps.workspaceDir, "scratch", input.threadId);
    await mkdir(cwd, { recursive: true });
    if (input.project && this.deps.prepareProject) await this.deps.prepareProject(input.project, input.agentId).catch((e) => logger.warn("prepareProject failed", { error: errMsg(e) }));

    const run = store.runs.create({ threadId: input.threadId, agentId: input.agentId });
    const token = tokens.mintRunToken({ runId: run.id, projectId: input.project?.id ?? null, threadId: input.threadId });
    const resume = store.runs.lastSession(input.threadId, input.agentId);
    const message = store.threads.addMessage({ threadId: input.threadId, role: "assistant", contentMd: "", parts: [], runId: run.id });
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
      emit({ ts: Date.now(), topic: "agent.delta", runId: run.id, messageId: message.id, part: kind, delta });
      persist();
    };

    emit({ ts: Date.now(), topic: "agent.started", runId: run.id, threadId: input.threadId, agentId: input.agentId });
    emit({ ts: Date.now(), topic: "thread.updated", threadId: input.threadId });

    const session: AgentSession = {
      cwd,
      prompt: input.prompt,
      attachments: input.attachments,
      mcp: { url: this.deps.mcpUrl, token },
      ...(resume ? { resume } : {}),
      ...(input.model ?? agentSettings?.model ? { model: (input.model ?? agentSettings?.model) as string } : {}),
      permission: agentSettings?.permissionMode ?? "acceptEdits",
      ...(agentSettings?.extraAllowedTools?.length ? { extraAllowedTools: agentSettings.extraAllowedTools } : {}),
      ...(agentSettings?.binaryPath ? { binaryPath: agentSettings.binaryPath } : {}),
    };

    let handle: AgentRun;
    try {
      handle = adapter.run(session);
    } catch (e) {
      const msg = errMsg(e);
      store.runs.finish(run.id, { status: "failed" });
      tokens.revokeRun(run.id);
      emit({ ts: Date.now(), topic: "agent.error", runId: run.id, message: msg });
      emit({ ts: Date.now(), topic: "agent.done", runId: run.id, threadId: input.threadId, status: "failed" });
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
          switch (ev.type) {
            case "init": {
              if (ev.sessionId) {
                sessionId = ev.sessionId;
                store.runs.setSession(run.id, ev.sessionId);
              }
              const failed = (ev.mcpServers ?? []).filter((s) => s.status !== "connected");
              if (failed.length) emit({ ts: Date.now(), topic: "agent.error", runId: run.id, message: `MCP server(s) not connected: ${failed.map((s) => `${s.name}=${s.status}`).join(", ")}` });
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
              emit({ ts: Date.now(), topic: "agent.tool_use", runId: run.id, messageId: message.id, id: ev.id, name: ev.name, input: ev.input });
              persist(true);
              break;
            case "tool_result":
              parts.push({ type: "tool_result", id: ev.id, output: ev.output, ...(ev.isError !== undefined ? { isError: ev.isError } : {}) });
              emit({ ts: Date.now(), topic: "agent.tool_result", runId: run.id, messageId: message.id, id: ev.id, output: ev.output, ...(ev.isError !== undefined ? { isError: ev.isError } : {}) });
              persist(true);
              break;
            case "usage":
              if (ev.inputTokens !== undefined) cost["inputTokens"] = (cost["inputTokens"] ?? 0) + ev.inputTokens;
              if (ev.outputTokens !== undefined) cost["outputTokens"] = (cost["outputTokens"] ?? 0) + ev.outputTokens;
              if (ev.costUsd !== undefined) cost["costUsd"] = (cost["costUsd"] ?? 0) + ev.costUsd;
              emit({ ts: Date.now(), topic: "agent.usage", runId: run.id, ...(ev.inputTokens !== undefined ? { inputTokens: ev.inputTokens } : {}), ...(ev.outputTokens !== undefined ? { outputTokens: ev.outputTokens } : {}), ...(ev.costUsd !== undefined ? { costUsd: ev.costUsd } : {}) });
              break;
            case "error":
              emit({ ts: Date.now(), topic: "agent.error", runId: run.id, message: ev.message });
              if (!aborted) status = "failed";
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
          emit({ ts: Date.now(), topic: "agent.error", runId: run.id, message: errMsg(e) });
        }
      }
      if (aborted) status = "aborted";
      persist(true);
      store.runs.finish(run.id, { status, exitCode: exitCode ?? null, cost });
      tokens.revokeRun(run.id);
      this.active.delete(run.id);
      store.threads.touch(input.threadId);
      emit({ ts: Date.now(), topic: "agent.done", runId: run.id, threadId: input.threadId, status, ...(sessionId ? { sessionId } : {}), ...(exitCode !== undefined ? { exitCode } : {}) });
      emit({ ts: Date.now(), topic: "thread.updated", threadId: input.threadId });
    })();

    this.active.set(run.id, {
      runId: run.id,
      threadId: input.threadId,
      abort: () => {
        aborted = true;
        try {
          handle.abort();
        } catch (e) {
          logger.warn("abort failed", { error: errMsg(e) });
        }
      },
      done,
    });
    return { runId: run.id, messageId: message.id };
  }
}
