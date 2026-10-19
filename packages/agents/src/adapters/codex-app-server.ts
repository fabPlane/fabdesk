import type { AgentEvent, AgentRun, AgentSession } from "../types";
import { readJsonl, readTail } from "../jsonl";
import { killTree } from "../process";
import { AGENT_OWNER_DIR, trackAgentProcess } from "../process-ownership";
import { CodexStreamParser } from "../parsers/codex";
import { isImage, promptWithAttachments } from "./shared";

export const APP_SERVER_QUESTION_INSTRUCTIONS =
  "You are running in fabPlane, whose client displays interactive question cards. When asking the user a question, call the blocking request_user_input tool or fabdesk's request_user_input MCP tool and wait for the submitted answer. Use concise choices when helpful; custom answers are supported. Do not use request_user_input_async, print pretend controls as Markdown lists, or continue dependent work without an answer.";

/** Bidirectional transport: exec's stdout-only interface loses native question requests. */
export function runCodexAppServer(session: AgentSession, cmd: string[], env: Record<string, string>): AgentRun {
  const child = Bun.spawn(cmd, { cwd: session.cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const events: AgentEvent[] = [];
  let wake: (() => void) | undefined;
  let finished = false;
  let stopped = false;
  let threadId: string | undefined;
  let turnId: string | undefined;
  let nextId = 0;
  let asyncQuestionBatches = 0;
  const askedItems = new Set<string>();
  const turnEndWaiters = new Map<string, () => void>();
  let stderr = "";
  const parser = new CodexStreamParser();
  const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const questionControllers = new Map<string | number, AbortController>();
  const push = (event: AgentEvent) => { events.push(event); wake?.(); wake = undefined; };
  const send = (message: unknown) => { if (!finished) child.stdin.write(JSON.stringify(message) + "\n"); };
  const rpc = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex did not respond to ${method}.`)); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    send({ id, method, params });
  });
  const finish = (exitCode: number) => {
    if (finished) return;
    finished = true;
    for (const controller of questionControllers.values()) controller.abort();
    for (const resolve of turnEndWaiters.values()) resolve();
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Codex connection closed.")); }
    pending.clear();
    push({ type: "done", exitCode, ...(threadId ? { sessionId: threadId } : {}) });
    killTree(child.pid, "SIGTERM");
  };
  const fail = (error: unknown) => { if (!finished && !stopped) push({ type: "error", message: error instanceof Error ? error.message : String(error) }); finish(1); };
  const onRequest = async (message: any) => {
    const { id, method, params } = message;
    if (method === "item/tool/requestUserInput" || method === "tool/requestUserInput") {
      if (!session.requestInput || params.threadId !== threadId) {
        send({ id, error: { code: -32600, message: "Question is not attached to this chat." } });
        return;
      }
      const controller = new AbortController();
      questionControllers.set(id, controller);
      try {
        const answers: Record<string, { answers: string[] }> = {};
        // Create every card immediately; each answer still uses its original protocol ID.
        await Promise.all(params.questions.map(async (question: any) => {
          if (question.isSecret) throw new Error("Secret input cannot be collected in chat history.");
          const options = question.options?.map((option: any) => option.description ? `${option.label} — ${option.description}` : option.label);
          const value = await session.requestInput!({ question: question.question, ...(options?.length ? { options } : {}), signal: controller.signal });
          answers[question.id] = { answers: value ? [value] : [] };
        }));
        if (!controller.signal.aborted) send({ id, result: { answers } });
      } catch (error) {
        send({ id, error: { code: -32603, message: error instanceof Error ? error.message : "Could not ask the question." } });
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
    if (p?.threadId && threadId && p.threadId !== threadId) return;
    if (method === "serverRequest/resolved") { questionControllers.get(p.requestId)?.abort(); return; }
    if (method === "item/agentMessage/delta") {
      for (const e of parser.feed({ type: "item.updated", item: { id: p.itemId, type: "agent_message", text: (textById.get(p.itemId) ?? "") + p.delta } })) push(e);
      textById.set(p.itemId, (textById.get(p.itemId) ?? "") + p.delta);
    } else if (method === "item/started" || method === "item/completed") {
      const types: Record<string, string> = { agentMessage: "agent_message", reasoning: "reasoning", commandExecution: "command_execution", fileChange: "file_change", mcpToolCall: "mcp_tool_call", webSearch: "web_search" };
      const item = p.item;
      if (!item || !types[item.type]) return;
      if (item.type === "agentMessage" && item.questions?.length && session.requestInput) {
        if (askedItems.has(item.id)) return;
        askedItems.add(item.id);
        asyncQuestionBatches++;
        const controller = new AbortController();
        questionControllers.set(item.id, controller);
        // Native async questions are structured AgentMessage metadata, not server requests.
        // Pause the native turn so it cannot guess and continue; resume with the actual answers.
        const end = new Promise<void>((resolve) => turnEndWaiters.set(p.turnId, resolve));
        const interrupted = rpc("turn/interrupt", { threadId, turnId: p.turnId });
        void (async () => {
          try {
            const answers = await Promise.all(item.questions.map(async (question: any) => ({
              question: question.title,
              answer: await session.requestInput!({ question: question.title, ...(question.options?.length ? { options: question.options } : {}), signal: controller.signal }),
            })));
            await interrupted;
            await end;
            asyncQuestionBatches--;
            questionControllers.delete(item.id);
            if (finished || controller.signal.aborted) return;
            if (answers.some((a: { answer: string }) => !a.answer)) { finish(1); return; }
            await rpc("turn/start", { threadId, input: [{ type: "text", text: `My answers to your questions:\n${JSON.stringify(answers)}`, text_elements: [] }] });
          } catch (error) { fail(error); }
        })();
        return;
      }
      const converted = { ...item, type: types[item.type], aggregated_output: item.aggregatedOutput, exit_code: item.exitCode };
      for (const e of parser.feed({ type: method === "item/started" ? "item.started" : "item.completed", item: converted })) push(e);
    } else if (method === "thread/tokenUsage/updated") {
      const usage = p.tokenUsage?.last;
      if (usage) push({ type: "usage", inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 });
    } else if (method === "turn/started") turnId = p.turn.id;
    else if (method === "turn/completed") {
      turnEndWaiters.get(p.turn.id)?.();
      turnEndWaiters.delete(p.turn.id);
      if (asyncQuestionBatches > 0) return;
      if (p.turn.status === "failed") fail(p.turn.error?.message ?? "Codex could not complete the request.");
      else finish(p.turn.status === "interrupted" ? 1 : 0);
    } else if (method === "error" && !p.willRetry) fail(p.error?.message ?? "Codex connection failed.");
  };
  const textById = new Map<string, string>();
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
  void child.exited.then(async (code) => { await stderrDone; if (!finished) fail(stderr.trim() || `Codex stopped unexpectedly (${code}).`); });
  const ownership = env[AGENT_OWNER_DIR] ? trackAgentProcess(env[AGENT_OWNER_DIR]!, child.pid) : Promise.resolve(async () => {});
  void child.exited.then(async () => { const cleanup = await ownership; await cleanup(); }).catch(() => {});
  void (async () => {
    await rpc("initialize", { clientInfo: { name: "fabplane", version: "0.2.0" }, capabilities: { experimentalApi: true } });
    send({ method: "initialized", params: {} });
    const options = {
      cwd: session.cwd,
      ...(session.model ? { model: session.model } : {}),
      approvalPolicy: session.permission === "bypass" ? "never" : "on-request",
      approvalsReviewer: session.permission === "bypass" ? "user" : "auto_review",
      sandbox: session.permission === "bypass" ? "danger-full-access" : "workspace-write",
      developerInstructions: APP_SERVER_QUESTION_INSTRUCTIONS,
    };
    const result = await rpc(session.resume ? "thread/resume" : "thread/start", { ...options, ...(session.resume ? { threadId: session.resume } : {}) });
    threadId = result.thread.id;
    push({ type: "init", sessionId: threadId! });
    const input = [{ type: "text", text: promptWithAttachments(session.prompt, session.attachments, { skipImages: true }), text_elements: [] }, ...session.attachments.filter(isImage).map((a) => ({ type: "localImage", path: a.path }))];
    await rpc("turn/start", { threadId, input });
  })().catch(fail);
  return {
    pid: child.pid,
    abort() { stopped = true; if (threadId && turnId) send({ id: ++nextId, method: "turn/interrupt", params: { threadId, turnId } }); finish(1); },
    events: (async function* () {
      while (!finished || events.length) {
        if (events.length) yield events.shift()!;
        else await new Promise<void>((resolve) => { wake = resolve; });
      }
    })(),
  };
}
