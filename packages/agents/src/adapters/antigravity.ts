import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { detectBinary, resolveFirst } from "../detect";
import { readJsonl } from "../jsonl";
import { AGENT_OWNER_DIR, trackAgentProcess } from "../process-ownership";
import { stopAgentProcess } from "../process";
import { MCP_SERVER_NAME, TOKEN_ENV, type AgentAdapter, type AgentEvent, type AgentRun, type AgentSession, type DetectResult } from "../types";
import { agentEnv, promptWithAttachments } from "./shared";

const candidates = process.platform === "win32"
  ? ["agy", join(process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"), "agy", "bin", "agy.exe")]
  : ["agy"];
const loginHint = "Authentication required. Sign in to Google Antigravity on the selected host with `agy acp --login`, then retry.";
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

function selectorFor(state: Record<string, unknown>, category: string) {
  const selector = list(state["configOptions"]).map(object)
    .find((option) => option["category"] === category || option["id"] === category);
  const models = new Map<string, string>();
  for (const entry of list(selector?.["options"]).map(object)) {
    // ACP permits either an ungrouped choice or a group containing choices.
    const choices = Array.isArray(entry["options"]) ? list(entry["options"]).map(object) : [entry];
    for (const choice of choices) {
      const value = string(choice["value"]);
      if (value && !models.has(value)) models.set(value, string(choice["name"]) || value);
    }
  }
  return { id: string(selector?.["id"]), current: string(selector?.["currentValue"]), models };
}

function concreteState(state: Record<string, unknown>) {
  const legacy = object(state["models"]);
  return {
    current: string(legacy["currentModelId"]),
    available: new Set(list(legacy["availableModels"]).map((item) => string(object(item)["modelId"]))),
  };
}

type Probe = (state: Record<string, unknown>) => void;
const discovery = new Map<string, Promise<Partial<DetectResult>>>();

async function detectAntigravity(binaryPath?: string): Promise<DetectResult> {
  const binary = await detectBinary(candidates, binaryPath);
  if (!binary.installed || !binary.path) return binary;
  const path = binary.path;
  let pending = discovery.get(path);
  if (!pending) {
    // Reuse only concurrent probes. A later refresh must see account changes.
    pending = (async () => {
      let reported: Partial<DetectResult> = {};
      try {
        const run = runAntigravity({ cwd: tmpdir(), prompt: "", attachments: [], mcp: { url: "", token: "" }, permission: "acceptEdits", binaryPath: path }, (state) => {
          const { current, models } = selectorFor(state, "model");
          reported = {
            models: [...models.keys()], modelAliases: Object.fromEntries(models),
            ...(current && models.has(current) ? { defaultModel: current } : {}),
          };
        });
        for await (const event of run.events) {
          if (event.type === "error") reported = {};
        }
      } catch { /* Installation remains valid when the account catalogue cannot be read. */ }
      return reported;
    })().finally(() => discovery.delete(path));
    discovery.set(path, pending);
  }
  return { ...binary, ...await pending };
}

export const antigravityAdapter: AgentAdapter = {
  id: "antigravity",
  displayName: "Google Antigravity",
  installHint: "Install the Antigravity CLI (agy) from https://antigravity.google/docs/cli-getting-started, then run `agy acp --login`.",
  detect: detectAntigravity,
  // Availability depends on the signed-in Google account and is reported per ACP session.
  models: () => [],
  // Native policy can pre-approve a tool before ACP sees it. Do not promise strict supervision.
  supportsSupervised: false,
  run: runAntigravity,
};

function runAntigravity(session: AgentSession, probe?: Probe): AgentRun {
  if (session.planningOnly || session.runtimeMode === "supervised") {
    throw new Error("Google Antigravity is not available in planning-only or supervised mode.");
  }
  const bin = resolveFirst(session.binaryPath ? [session.binaryPath] : candidates);
  if (!bin) throw new Error(`Google Antigravity agent is not installed. ${antigravityAdapter.installHint}`);
  // Agy can write ACP diagnostics to a log. Keep them out of the project and remove on exit.
  const temp = mkdtempSync(join(tmpdir(), "fabdesk-agy-"));
  const cwd = probe ? temp : session.cwd;
  const env = agentEnv(session);
  delete env[TOKEN_ENV]; // The process gets only the per-run HTTP header over ACP, not tool env.
  let proc;
  try {
    proc = Bun.spawn([bin, "acp", "--sandbox", "--process-per-session", "--disable-telemetry", "--log-file", join(temp, "acp.log")], {
      cwd, env, stdin: "pipe", stdout: "pipe", stderr: "ignore", windowsHide: true,
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
        } else if (active && !interaction && allowOnce.length === 1 && session.runtimeMode === "full") {
          // "Run without approval": the user chose no approval pauses, so a native prompt is
          // answered with its single allow-once option. The CLI still runs sandboxed, and a
          // prompt with no or several allow options stays unanswered rather than guessed.
          optionId = string(allowOnce[0]!["optionId"]);
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
          const init = object(await rpc("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "fabdesk", version: "1" } }, probe ? 5_000 : undefined));
          if (init["protocolVersion"] !== 1) throw new Error("This Antigravity CLI does not support ACP version 1. Update agy.");
          const caps = object(init["agentCapabilities"]);
          if (probe) {
            // No project, MCP, model change or prompt is given to a catalogue probe.
            const state = object(await rpc("session/new", { cwd, mcpServers: [] }, 24_000));
            sessionId = string(state["sessionId"]);
            if (!sessionId) throw new Error("Google Antigravity did not return a session ID.");
            probe(state);
            if ("close" in object(caps["sessionCapabilities"])) {
              await rpc("session/close", { sessionId }, 1_000).catch(() => {});
            }
            exitCode = 0;
            return;
          }
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
          let selectedState = state;
          let selection = selectorFor(state, "model");
          const concrete = concreteState(state);
          const selected = session.model ?? concrete.current ?? selection.current;
          if (session.model && session.model !== selection.current && session.model !== concrete.current) {
            let value = session.model, effort: string | undefined;
            if (!selection.models.has(value) && concrete.available.has(value)) {
              // Older saved IDs include thinking level. Migrate only an exact variant
              // the same account advertises, and confirm both options before prompting.
              const level = selectorFor(state, "thought_level");
              const family = [...selection.models.keys()].filter((id) => value.startsWith(id + "-"))
                .sort((a, b) => b.length - a.length)[0];
              if (family && level.models.has(value.slice(family.length + 1))) {
                effort = value.slice(family.length + 1);
                value = family;
              }
            }
            if (!selection.id || !selection.models.has(value)) {
              throw new Error("The selected model is not available to this Antigravity account. Refresh the model list or choose Antigravity’s default.");
            }
            if (selection.current !== value) {
              selectedState = object(await rpc("session/set_config_option", { sessionId, configId: selection.id, value }));
              selection = selectorFor(selectedState, "model");
              if (selection.current !== value) {
                throw new Error("Google Antigravity did not confirm the selected model. No prompt was sent.");
              }
            }
            if (effort) {
              const level = selectorFor(selectedState, "thought_level");
              if (!level.id || !level.models.has(effort)) {
                throw new Error("This Antigravity model no longer reports the requested thinking level. No prompt was sent.");
              }
              if (level.current !== effort) {
                selectedState = object(await rpc("session/set_config_option", { sessionId, configId: level.id, value: effort }));
                if (selectorFor(selectedState, "thought_level").current !== effort || selectorFor(selectedState, "model").current !== value) {
                  throw new Error("Google Antigravity did not confirm the selected model and thinking level. No prompt was sent.");
                }
              }
            }
          }
          emit({ type: "init", sessionId, ...(selected ? { model: selected } : {}) });
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
