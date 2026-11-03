import type { AgentEvent, AgentRun, AgentSession } from "../types";
import { readJsonl, readTail } from "../jsonl";
import { stopAgentProcess } from "../process";
import { AGENT_OWNER_DIR, trackAgentProcess } from "../process-ownership";
import { CodexStreamParser } from "../parsers/codex";
import { isImage, promptWithAttachments } from "./shared";

export const APP_SERVER_QUESTION_INSTRUCTIONS =
  "You are running in fabPlane, whose client displays interactive question cards. When asking the user a question, call the blocking request_user_input tool or fabdesk's request_user_input MCP tool and wait for the submitted answer. Prefer the native blocking tool when available. If an MCP call through a code-mode exec wrapper returns Script running with cell ID, use the matching wait tool with that cell ID until it completes; do not end the turn while that question is still waiting. Use concise choices when helpful; custom answers are supported. Do not use request_user_input_async, print pretend controls as Markdown lists, or continue dependent work without an answer.";

/** Bidirectional transport: exec's stdout-only interface loses native question requests. */
export function runCodexAppServer(session: AgentSession, cmd: string[], env: Record<string, string>): AgentRun {
  const child = Bun.spawn(cmd, { cwd: session.cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const events: AgentEvent[] = [];
  let wake: (() => void) | undefined;
  let finished = false;
  let finishing = false;
  let shutdown: Promise<void> | undefined;
  let stopped = false;
  let threadId: string | undefined;
  let turnId: string | undefined;
  let nextId = 0;
  const askedItems = new Set<string>();
  type QuestionTurn = { id: string; pending: number; ended: boolean; interrupted: boolean; answers: Array<{ question: string; answer: string }> };
  let questionTurn: QuestionTurn | undefined;
  let stderr = "";
  const parser = new CodexStreamParser();
  const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const questionControllers = new Map<string | number, AbortController>();
  const push = (event: AgentEvent) => { events.push(event); wake?.(); wake = undefined; };
  const send = (message: unknown) => { if (!finishing) child.stdin.write(JSON.stringify(message) + "\n"); };
  const rpc = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    if (finishing) { reject(new Error("Codex connection closed.")); return; }
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex did not respond to ${method}.`)); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    send({ id, method, params });
  });
  const finish = (exitCode: number) => {
    if (finishing) return;
    finishing = true;
    for (const controller of questionControllers.values()) controller.abort();
    questionControllers.clear();
    questionTurn = undefined;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Codex connection closed.")); }
    pending.clear();
    shutdown = (async () => {
      await stopAgentProcess(child);
      const cleanup = await ownership;
      await cleanup().catch((error) => console.error(`agent ownership cleanup failed: ${String(error)}`));
      finished = true;
      push({ type: "done", exitCode, ...(threadId ? { sessionId: threadId } : {}) });
    })();
  };
  const fail = (error: unknown) => { if (!finishing && !stopped) push({ type: "error", message: error instanceof Error ? error.message : String(error) }); finish(1); };
  const noAnswer = () => new Error("No answer was received for the question. Send a message to ask it again, then choose an option or type your answer.");
  const resumeQuestions = (state: QuestionTurn) => {
    if (finishing || questionTurn !== state || state.pending || !state.ended || !state.interrupted) return;
    questionTurn = undefined;
    void rpc("turn/start", { threadId, input: [{ type: "text", text: `My answers to your questions:\n${JSON.stringify(state.answers)}`, text_elements: [] }] }).catch(fail);
  };
  const onRequest = async (message: any) => {
    if (finishing) return;
    const { id, method, params } = message;
    if (method === "item/tool/requestUserInput" || method === "tool/requestUserInput") {
      if (!session.requestInput || params.threadId !== threadId || params.turnId !== turnId) {
        send({ id, error: { code: -32600, message: "Question is not attached to this chat." } });
        return;
      }
      const controller = new AbortController();
      questionControllers.set(id, controller);
      try {
        // Validate the entire batch before opening any cards (especially secret inputs).
        if (!Array.isArray(params.questions) || !params.questions.length) throw new Error("The question request was empty.");
        if (params.questions.some((q: any) => q.isSecret)) throw new Error("Secret input cannot be collected in chat history.");
        const answers: Record<string, { answers: string[] }> = {};
        // Create every card immediately; each answer still uses its original protocol ID.
        await Promise.all(params.questions.map(async (question: any) => {
          const options = question.options?.map((option: any) => option.description ? `${option.label} — ${option.description}` : option.label);
          const value = await session.requestInput!({ question: question.question, ...(options?.length ? { options } : {}), signal: controller.signal });
          if (!value.trim() && !controller.signal.aborted) throw noAnswer();
          answers[question.id] = { answers: [value] };
        }));
        if (!controller.signal.aborted) send({ id, result: { answers } });
      } catch (error) {
        const cancelled = controller.signal.aborted;
        controller.abort();
        send({ id, error: { code: -32603, message: error instanceof Error ? error.message : "Could not ask the question." } });
        if (!cancelled) fail(error);
      } finally { questionControllers.delete(id); }
      return;
    }
    // Approval policy remains with Codex's configured reviewer; never silently grant an
    // unexpected request to widen filesystem/network access from this question transport.
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      send({ id, result: { decision: "decline" } });
      push({ type: "error", message: "Codex requested permission that could not be reviewed. Check the agent permission settings." });
    } else send({ id, error: { code: -32601, message: `Unsupported client request: ${method}` } });
  };
  const onNotification = (method: string, p: any) => {
    if (finishing) return;
    if (p?.threadId && threadId && p.threadId !== threadId) return;
    if (p?.turnId && turnId && p.turnId !== turnId) return;
    if (method === "serverRequest/resolved") { questionControllers.get(p.requestId)?.abort(); return; }
    if (method === "item/agentMessage/delta") {
      for (const e of parser.feed({ type: "item.updated", item: { id: p.itemId, type: "agent_message", text: (textById.get(p.itemId) ?? "") + p.delta } })) push(e);
      textById.set(p.itemId, (textById.get(p.itemId) ?? "") + p.delta);
    } else if (method === "item/reasoning/summaryTextDelta") {
      const parts = summaries.get(p.itemId) ?? [];
      parts[p.summaryIndex ?? 0] = (parts[p.summaryIndex ?? 0] ?? "") + p.delta;
      summaries.set(p.itemId, parts);
      for (const e of parser.feed({ type: "item.updated", item: { id: p.itemId, type: "reasoning", text: parts.join("\n\n") } })) push(e);
    } else if (method === "item/started" || method === "item/completed") {
      const types: Record<string, string> = { agentMessage: "agent_message", reasoning: "reasoning", commandExecution: "command_execution", fileChange: "file_change", mcpToolCall: "mcp_tool_call", webSearch: "web_search" };
      const item = p.item;
      if (!item || !types[item.type]) return;
      if (item.type === "agentMessage" && item.questions?.length && session.requestInput) {
        if (askedItems.has(item.id)) return;
        askedItems.add(item.id);
        let state = questionTurn;
        if (!state) {
          state = { id: p.turnId, pending: 0, ended: false, interrupted: false, answers: [] };
          questionTurn = state;
          const current = state;
          // Attach rejection handling immediately, even while the user is still answering.
          void rpc("turn/interrupt", { threadId, turnId: p.turnId }).then(() => {
            current.interrupted = true;
            resumeQuestions(current);
          }).catch(fail);
        }
        const current = state;
        current.pending++;
        const controller = new AbortController();
        questionControllers.set(item.id, controller);
        // Native async questions are structured AgentMessage metadata, not server requests.
        // Pause the native turn so it cannot guess and continue; resume with the actual answers.
        void (async () => {
          try {
            const answers = await Promise.all(item.questions.map(async (question: any) => ({
              question: question.title,
              answer: await session.requestInput!({ question: question.title, ...(question.options?.length ? { options: question.options } : {}), signal: controller.signal }),
            })));
            if (finishing || controller.signal.aborted) return;
            if (answers.some((a: { answer: string }) => !a.answer.trim())) throw noAnswer();
            current.answers.push(...answers);
            current.pending--;
            resumeQuestions(current);
          } catch (error) { if (!controller.signal.aborted) fail(error); }
          finally { questionControllers.delete(item.id); }
        })();
        return;
      }
      const converted = { ...item, type: types[item.type], ...(item.type === "reasoning" ? { text: (item.summary ?? summaries.get(item.id) ?? []).join("\n\n") } : {}), aggregated_output: item.aggregatedOutput, exit_code: item.exitCode };
      for (const e of parser.feed({ type: method === "item/started" ? "item.started" : "item.completed", item: converted })) push(e);
    } else if (method === "thread/tokenUsage/updated") {
      const usage = p.tokenUsage?.last;
      if (usage) push({ type: "usage", inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 });
    } else if (method === "turn/started") turnId = p.turn.id;
    else if (method === "turn/completed") {
      if (p.turn.id !== turnId) return;
      if (questionTurn && questionTurn.id === p.turn.id && p.turn.status !== "failed") {
        questionTurn.ended = true;
        resumeQuestions(questionTurn);
        return;
      }
      if (p.turn.status === "failed") fail(p.turn.error?.message ?? "Codex could not complete the request.");
      else finish(p.turn.status === "interrupted" ? 1 : 0);
    } else if (method === "error" && !p.willRetry) fail(p.error?.message ?? "Codex connection failed.");
  };
  const textById = new Map<string, string>();
  const summaries = new Map<string, string[]>();
  const stderrDone = readTail(child.stderr, 4000).then((text) => { stderr = text; }).catch(() => {});
  void (async () => {
    try {
      for await (const message of readJsonl(child.stdout)) {
        const m = message as any;
        if (m.method && m.id !== undefined) void onRequest(m).catch(fail);
        else if (m.method) onNotification(m.method, m.params);
        else if (typeof m.id === "number") {
          const request = pending.get(m.id);
          if (!request) continue;
          clearTimeout(request.timer); pending.delete(m.id);
          if (m.error) request.reject(new Error(m.error.message)); else request.resolve(m.result);
        }
      }
    } catch (error) { fail(error); }
  })();
  void child.exited.then(async (code) => { await stderrDone; if (!finishing) fail(stderr.trim() || `Codex stopped unexpectedly (${code}).`); });
  const ownership = (env[AGENT_OWNER_DIR] ? trackAgentProcess(env[AGENT_OWNER_DIR]!, child.pid) : Promise.resolve(async () => {})).catch((error) => {
    console.error(`agent ownership capture failed: ${String(error)}`);
    return async () => {};
  });
  void (async () => {
    await rpc("initialize", { clientInfo: { name: "fabplane", version: "0.2.0" }, capabilities: { experimentalApi: true } });
    send({ method: "initialized", params: {} });
    const options = {
      cwd: session.cwd,
      ...(session.model ? { model: session.model } : {}),
      approvalPolicy: session.planningOnly || session.permission === "bypass" ? "never" : "on-request",
      approvalsReviewer: session.permission === "bypass" ? "user" : "auto_review",
      sandbox: session.planningOnly ? "read-only" : session.permission === "bypass" ? "danger-full-access" : "workspace-write",
      developerInstructions: APP_SERVER_QUESTION_INSTRUCTIONS,
    };
    const result = await rpc(session.resume ? "thread/resume" : "thread/start", { ...options, ...(session.resume ? { threadId: session.resume } : {}) });
    threadId = result.thread.id;
    push({ type: "init", sessionId: threadId! });
    const input = [{ type: "text", text: promptWithAttachments(session.prompt, session.attachments, { skipImages: true }), text_elements: [] }, ...session.attachments.filter(isImage).map((a) => ({ type: "localImage", path: a.path }))];
    await rpc("turn/start", { threadId, input, ...(session.effort ? { effort: session.effort } : {}) });
  })().catch(fail);
  return {
    pid: child.pid,
    abort() { stopped = true; if (threadId && turnId) send({ id: ++nextId, method: "turn/interrupt", params: { threadId, turnId } }); finish(1); },
    events: (async function* () {
      try {
        while (!finished || events.length) {
          if (events.length) yield events.shift()!;
          else await new Promise<void>((resolve) => { wake = resolve; });
        }
      } finally { finish(1); await shutdown; }
    })(),
  };
}
