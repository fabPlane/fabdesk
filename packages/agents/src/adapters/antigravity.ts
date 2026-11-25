import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { detectBinary, resolveFirst } from "../detect";
import { readJsonl } from "../jsonl";
import { AGENT_OWNER_DIR, trackAgentProcess } from "../process-ownership";
import { stopAgentProcess } from "../process";
import { MCP_SERVER_NAME, TOKEN_ENV, type AgentAdapter, type AgentEvent, type AgentRun, type AgentSession } from "../types";
import { agentEnv, promptWithAttachments } from "./shared";

const candidates = process.platform === "win32"
  ? ["agy", join(process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"), "agy", "bin", "agy.exe")]
  : ["agy"];
const loginHint = "Authentication required. Sign in to Google Antigravity on the selected host with `agy acp --login`, then retry.";
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

export const antigravityAdapter: AgentAdapter = {
  id: "antigravity",
  displayName: "Google Antigravity",
  installHint: "Install the Antigravity CLI (agy) from https://antigravity.google/docs/cli-getting-started, then run `agy acp --login`.",
  detect: (binaryPath) => detectBinary(candidates, binaryPath),
  // Availability depends on the signed-in Google account and is reported per ACP session.
  models: () => [],
  // Native policy can pre-approve a tool before ACP sees it. Do not promise strict supervision.
  supportsSupervised: false,
  run: runAntigravity,
};

function runAntigravity(session: AgentSession): AgentRun {
  if (session.planningOnly || session.runtimeMode === "supervised") {
    throw new Error("Google Antigravity is not available in planning-only or supervised mode.");
  }
  const bin = resolveFirst(session.binaryPath ? [session.binaryPath] : candidates);
  if (!bin) throw new Error(`Google Antigravity agent is not installed. ${antigravityAdapter.installHint}`);
  // Agy can write ACP diagnostics to a log. Keep them out of the project and remove on exit.
  const temp = mkdtempSync(join(tmpdir(), "fabdesk-agy-"));
  const env = agentEnv(session);
  delete env[TOKEN_ENV]; // The process gets only the per-run HTTP header over ACP, not tool env.
  let proc;
  try {
    proc = Bun.spawn([bin, "acp", "--sandbox", "--process-per-session", "--disable-telemetry", "--log-file", join(temp, "acp.log")], {
      cwd: session.cwd, env, stdin: "pipe", stdout: "pipe", stderr: "ignore", windowsHide: true,
    });
  } catch {
    rmSync(temp, { recursive: true, force: true });
    throw new Error("The Google Antigravity CLI could not be started. Check the configured executable.");
  }
  const child = proc;
  const ownership = (env[AGENT_OWNER_DIR] ? trackAgentProcess(env[AGENT_OWNER_DIR], child.pid) : Promise.resolve(async () => {}))
    .catch(() => async () => {});
  let nextId = 0;
  let stopped = false;
  let prompting = false;
  let sessionId: string | undefined;
  const abortController = new AbortController();
  let stop: Promise<void> | undefined;
  const stopProcess = () => stop ??= stopAgentProcess(child);
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const rejectPending = (reason: string) => {
    for (const rpc of waiting.values()) rpc.reject(new Error(reason));
    waiting.clear();
  };
  const send = (message: Record<string, unknown>) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    child.stdin.flush();
  };
  const rpc = (method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> => {
    if (stopped) return Promise.reject(new Error("Google Antigravity was stopped."));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`Google Antigravity timed out during ${method}.`));
      }, timeoutMs) : undefined;
      waiting.set(id, {
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(error) { clearTimeout(timer); reject(error); },
      });
      try { send({ id, method, params }); }
      catch { waiting.get(id)?.reject(new Error("Could not write to the Antigravity CLI.")); waiting.delete(id); }
    });
  };
  const abort = () => {
    if (stopped) return;
    stopped = true;
    abortController.abort();
    if (sessionId && prompting) {
      try { send({ method: "session/cancel", params: { sessionId } }); } catch { /* already closed */ }
    }
    rejectPending("Google Antigravity was stopped.");
    void stopProcess().catch(() => {});
  };

  const stream = new ReadableStream<AgentEvent>({
    start(controller) {
      const emit = (event: AgentEvent) => { if (!stopped) controller.enqueue(event); };
      const calls = new Set<string>();
      const reply = async (id: unknown, method: string, params: Record<string, unknown>) => {
        if (method !== "session/request_permission") {
          if (!stopped) send({ id, error: { code: -32601, message: "Client method not supported" } });
          return;
        }
        let optionId: string | undefined;
        const toolCall = object(params["toolCall"]);
        const options = list(params["options"]).map(object);
        const allowOnce = options.filter((option) => option["kind"] === "allow_once");
        const denyOnce = options.find((option) => option["kind"] === "reject_once");
        const title = string(toolCall["title"]);
        const active = prompting && params["sessionId"] === sessionId;
        // Antigravity encodes fixed-choice questions as synthetic permission requests.
        // Neither a binary approval nor an unlisted answer may choose an option.
        const interaction = string(toolCall["toolCallId"])?.startsWith("interaction_") === true;
        if (active && interaction && title && session.requestInput) {
          const choices = new Map<string, string>();
          for (const option of allowOnce) {
            const label = string(option["name"])?.trim();
            const value = string(option["optionId"]);
            if (label && value) choices.set(label, value);
          }
          if (choices.size > 0 && choices.size === allowOnce.length && new Set(choices.values()).size === choices.size) {
            const answer = await session.requestInput({
              question: title,
              options: [...choices.keys()],
              signal: abortController.signal,
            }).catch(() => "");
            optionId = choices.get(answer.trim());
          }
        } else if (active && !interaction && allowOnce.length <= 1 && session.requestApproval) {
          const decision = await session.requestApproval({
            tool: title ?? "Antigravity tool",
            input: toolCall["rawInput"] ?? {},
          }).catch(() => "deny");
          optionId = string((decision === "approve" ? allowOnce[0] : denyOnce)?.["optionId"]);
        }
        if (!stopped) send({ id, result: { outcome: optionId
          ? { outcome: "selected", optionId }
          : { outcome: "cancelled" } } });
      };
      const updates = async () => {
        try {
          for await (const raw of readJsonl(child.stdout)) {
            const msg = object(raw);
            if (msg["jsonrpc"] !== "2.0" || stopped) continue;
            const method = string(msg["method"]);
            const params = object(msg["params"]);
            if (method && (typeof msg["id"] === "number" || typeof msg["id"] === "string")) {
              // Do not block stdout while a human decides.
              void reply(msg["id"], method, params).catch(() => {});
            } else if (method === "session/update" && prompting && params["sessionId"] === sessionId) {
              const update = object(params["update"]);
              const kind = update["sessionUpdate"];
              const content = object(update["content"]);
              const delta = content["type"] === "text" ? string(content["text"]) : undefined;
              if (delta && (kind === "agent_message_chunk" || kind === "agent_thought_chunk")) {
                emit({ type: kind === "agent_message_chunk" ? "text" : "thinking", delta });
              }
              if (kind === "tool_call" || kind === "tool_call_update") {
                const id = string(update["toolCallId"]);
                if (!id || id.startsWith("interaction_")) continue;
                if (kind === "tool_call" && !calls.has(id)) {
                  calls.add(id);
                  emit({ type: "tool_use", id, name: string(update["title"]) ?? "Antigravity tool", input: update["rawInput"] ?? {} });
                }
                const status = update["status"];
                if (calls.has(id) && (status === "completed" || status === "failed")) {
                  calls.delete(id);
                  emit({ type: "tool_result", id, output: update["rawOutput"] ?? update["content"] ?? "", isError: status === "failed" });
                }
              }
            } else if (typeof msg["id"] === "number" && !method) {
              const request = waiting.get(msg["id"]);
              if (!request) continue;
              waiting.delete(msg["id"]);
              if (msg["error"]) {
                const error = object(msg["error"]);
                // Do not forward raw RPC diagnostics: a peer may include credentials or headers.
                const auth = error["code"] === -32000 || /authentication required/i.test(string(error["message"]) ?? "");
                const code = typeof error["code"] === "number" ? ` (ACP ${error["code"]})` : "";
                request.reject(new Error(auth ? loginHint : `The Google Antigravity CLI rejected the request${code}.`));
              } else request.resolve(msg["result"]);
            }
          }
        } finally { rejectPending("Google Antigravity closed the connection before replying."); }
      };
      const reader = updates().catch(() => {});
      void (async () => {
        let exitCode = 1;
        try {
          const init = object(await rpc("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "fabdesk", version: "1" } }));
          if (init["protocolVersion"] !== 1) throw new Error("This Antigravity CLI does not support ACP version 1. Update agy.");
          const caps = object(init["agentCapabilities"]);
          if (object(caps["mcpCapabilities"])["http"] !== true)
            throw new Error("This Antigravity CLI does not offer HTTP MCP. Update agy to use FabDesk tools.");
          const config = {
            cwd: session.cwd,
            mcpServers: [{ type: "http", name: MCP_SERVER_NAME, url: session.mcp.url,
              headers: [{ name: "Authorization", value: `Bearer ${session.mcp.token}` }] }],
          };
          if (session.resume && caps["loadSession"] !== true) throw new Error("This Antigravity CLI cannot resume the existing session.");
          const state = object(await (session.resume
            ? rpc("session/load", { ...config, sessionId: session.resume })
            : rpc("session/new", config)));
          sessionId = session.resume ?? string(state["sessionId"]);
          if (!sessionId) throw new Error("Google Antigravity did not return a session ID.");
          if (session.model) {
            const model = list(state["configOptions"]).map(object).find((option) => option["category"] === "model" || option["id"] === "model");
            const configId = string(model?.["id"]);
            if (!configId) throw new Error("Google Antigravity did not report a model selector for this account. Use its default model.");
            await rpc("session/set_config_option", { sessionId, configId, value: session.model });
          }
          emit({ type: "init", sessionId, ...(session.model ? { model: session.model } : {}) });
          prompting = true;
          const turn = object(await rpc("session/prompt", {
            sessionId, prompt: [{ type: "text", text: promptWithAttachments(session.prompt, session.attachments) }],
          }, 0));
          prompting = false;
          if (turn["stopReason"] !== "end_turn" && turn["stopReason"] !== "cancelled") {
            throw new Error("Google Antigravity ended the turn without completing it.");
          }
          exitCode = turn["stopReason"] === "end_turn" ? 0 : 130;
        } catch (error) {
          emit({ type: "error", message: error instanceof Error ? error.message : "Google Antigravity failed." });
        } finally {
          const cancelled = abortController.signal.aborted;
          stopped = true;
          try {
            await stopProcess();
            await reader;
            await (await ownership)();
          } finally {
            rmSync(temp, { recursive: true, force: true });
            controller.enqueue({ type: "done", exitCode: cancelled ? 130 : exitCode, ...(sessionId ? { sessionId } : {}) });
            controller.close();
          }
        }
      })().catch(() => {});
    },
    cancel: abort,
  });
  async function* events(): AsyncGenerator<AgentEvent> {
    const reader = stream.getReader();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      reader.releaseLock();
      abort();
    }
  }
  return { events: events(), abort, pid: child.pid };
}
