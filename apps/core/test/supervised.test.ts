import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  CoreEvent,
  Message,
  PairClaimResult,
  PairStartResult,
  PendingRequests,
  Thread,
} from "@fabdesk/protocol";
import type { AgentEvent, AgentRun, AgentSession } from "@fabdesk/agents";
import type { CoreServices } from "@fabdesk/tools";
import { serve, type Daemon } from "../src/serve";
import { mockServices } from "../../../packages/tools/test/mock-services";

let daemon: Daemon;
let home: string;
const REMOTE = { enabled: true, host: "127.0.0.1", port: 47822 };
const remoteUrl = `http://${REMOTE.host}:${REMOTE.port}`;
const APPROVAL_TIMEOUT_MS = 250;

/** Runs the test can hold open: `hold:<key>` prompts wait until `release(key)`. */
const gates = new Map<string, () => void>();
const release = (key: string) => gates.get(key)?.();
const sessions: AgentSession[] = [];

/**
 * A fake Claude: the prompt says what to do. `approve:<cmd>` asks the supervisor about a Bash
 * call and reports the decision as the tool result; `ask` asks a question; `hold:<key>` keeps the
 * run alive (so an MCP permission prompt or a queued message has something to wait for).
 */
function fakeRun(session: AgentSession): AgentRun {
  sessions.push(session);
  return {
    events: (async function* (): AsyncGenerator<AgentEvent> {
      yield { type: "init", sessionId: "s1" };
      const [verb, arg = ""] = session.prompt.split(":", 2) as [string, string?];
      if (verb === "approve") {
        yield { type: "tool_use", id: "tu1", name: "Bash", input: { command: arg } };
        const decision = await session.supervisor!.requestApproval({
          tool: "Bash",
          input: { command: arg },
        });
        yield {
          type: "tool_result",
          id: "tu1",
          output: { decision },
          isError: decision === "deny",
        };
        yield { type: "text", delta: decision === "approve" ? "ran it" : "skipped it" };
      } else if (verb === "ask") {
        const answer = await session.supervisor!.requestInput({
          question: "Which regulator?",
          options: ["LDO", "Buck"],
        });
        yield { type: "text", delta: `you said ${answer}` };
      } else if (verb === "hold") {
        await new Promise<void>((r) => gates.set(arg, r));
        yield { type: "text", delta: "released" };
      } else {
        yield { type: "text", delta: `echo ${session.prompt}` };
      }
      yield { type: "done", exitCode: 0 };
    })(),
    abort() {},
  };
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "fabdesk-supervised-"));
  process.env["FABDESK_PROJECTS_DIR"] = join(home, "Fabdesk");
  process.env["FABDESK_TOKEN"] = "supervised-test-token-0123456789";
  daemon = await serve({
    port: 0,
    dataDir: home,
    handshakeFile: join(home, "daemon.json"),
    localAuth: true,
    quiet: true,
    watchProjects: false,
    approvalTimeoutMs: APPROVAL_TIMEOUT_MS,
    // fakeRun ignores abort, so a Stop answers after this bounded wait with `settled: false`.
    abortSettleTimeoutMs: 150,
    services: async ({ projects, bus, store }) =>
      mockServices([], {
        projects,
        bus: { emit: (e) => bus.emit(e) },
        routeRuns: store.routeRuns,
        channel: "public",
      }) as unknown as CoreServices,
    adapters: {
      claude: { id: "claude", supportsSupervised: true, run: fakeRun },
      // Codex's exec adapter cannot pause (see packages/agents/src/adapters/codex.ts).
      codex: { id: "codex", supportsSupervised: false, run: fakeRun },
    },
    doctor: async () => ({
      version: "t",
      channel: "public",
      bun: Bun.version,
      platform: "test",
      kicad: { found: false },
      ngspice: { found: false },
      routers: [],
      agents: [],
      warnings: [],
    }),
  });
  await local("/settings", { method: "PATCH", body: JSON.stringify({ remote: REMOTE }) });
});

afterAll(async () => {
  await daemon.close("tests done");
});

const H = () => ({ authorization: `Bearer ${daemon.token}`, "content-type": "application/json" });
const local = (path: string, init: RequestInit = {}) =>
  fetch(`${daemon.url}${path}`, { ...init, headers: { ...H(), ...(init.headers ?? {}) } });
const json = async <T>(r: Response | Promise<Response>): Promise<T> =>
  (await (await r).json()) as T;

type ThreadDetail = Thread & { running: boolean; pending: PendingRequests };
const newThread = (body: Record<string, unknown> = {}) =>
  json<Thread>(
    local("/threads", {
      method: "POST",
      body: JSON.stringify({ agentId: "claude", runtimeMode: "supervised", ...body }),
    }),
  );
const send = (threadId: string, content: string, extra: Record<string, unknown> = {}) =>
  local(`/threads/${threadId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content, ...extra }),
  });
const detail = (threadId: string) => json<ThreadDetail>(local(`/threads/${threadId}`));
const messages = (threadId: string) => json<Message[]>(local(`/threads/${threadId}/messages`));
const decide = (
  threadId: string,
  requestId: string,
  decision: "approve" | "deny",
  init: RequestInit = {},
) =>
  local(`/threads/${threadId}/approvals/${requestId}`, {
    method: "POST",
    body: JSON.stringify({ decision }),
    ...init,
  });

/** Collects bus events from the loopback socket until the test is done with them. */
function listen(
  topics: string,
  token = daemon.token,
  base = daemon.url,
): { events: CoreEvent[]; close(): void; ready: Promise<void> } {
  const events: CoreEvent[] = [];
  const ws = new WebSocket(
    `${base.replace(/^http/, "ws")}/ws?topics=${topics}&token=${encodeURIComponent(token)}`,
  );
  ws.onmessage = (m) => events.push((JSON.parse(String(m.data)) as { event: CoreEvent }).event);
  const ready = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("socket failed"));
  });
  return { events, close: () => ws.close(), ready };
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) await Bun.sleep(10);
  expect(pred()).toBe(true);
}
const ofTopic = <T extends CoreEvent["topic"]>(events: CoreEvent[], topic: T) =>
  events.filter((e): e is Extract<CoreEvent, { topic: T }> => e.topic === topic);

async function pairPhone(label: string): Promise<string> {
  const start = await json<PairStartResult>(local("/v1/devices/pair/start", { method: "POST" }));
  const claim = await json<PairClaimResult>(
    fetch(`${remoteUrl}/v1/devices/pair/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingToken: start.pairingToken, label, platform: "ios" }),
    }),
  );
  return claim.deviceToken;
}

describe("runtime mode", () => {
  test("threads carry it; the setting is the default for new ones", async () => {
    const plain = await json<Thread>(
      local("/threads", { method: "POST", body: JSON.stringify({ agentId: "claude" }) }),
    );
    expect(plain.runtimeMode).toBe("full");
    const supervised = await newThread();
    expect(supervised.runtimeMode).toBe("supervised");
    const patched = await json<Thread>(
      local(`/threads/${plain.id}`, {
        method: "PATCH",
        body: JSON.stringify({ runtimeMode: "supervised" }),
      }),
    );
    expect(patched.runtimeMode).toBe("supervised");

    await local("/settings", {
      method: "PATCH",
      body: JSON.stringify({ defaultRuntimeMode: "supervised" }),
    });
    expect(
      (
        await json<Thread>(
          local("/threads", { method: "POST", body: JSON.stringify({ agentId: "claude" }) }),
        )
      ).runtimeMode,
    ).toBe("supervised");
    // A default the agent cannot honour falls back to full rather than blocking the thread…
    expect(
      (
        await json<Thread>(
          local("/threads", { method: "POST", body: JSON.stringify({ agentId: "codex" }) }),
        )
      ).runtimeMode,
    ).toBe("full");
    await local("/settings", {
      method: "PATCH",
      body: JSON.stringify({ defaultRuntimeMode: "full" }),
    });
  });

  test("…but asking for it by name on an agent that cannot pause is a 400", async () => {
    const res = await local("/threads", {
      method: "POST",
      body: JSON.stringify({ agentId: "codex", runtimeMode: "supervised" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "agent cannot run supervised", code: "approval_not_supported" });
    const t = await newThread();
    const switched = await local(`/threads/${t.id}`, {
      method: "PATCH",
      body: JSON.stringify({ agentId: "codex" }),
    });
    expect(switched.status).toBe(400);
    expect((await detail(t.id)).agentId).toBe("claude");
  });
});

describe("approvals", () => {
  test("request event, pending, message part; approve resumes the run", async () => {
    const t = await newThread();
    const bus = listen("agent.*,thread.*");
    await bus.ready;
    expect((await send(t.id, "approve:rm -rf build")).status).toBe(202);
    await waitFor(() => ofTopic(bus.events, "agent.approval_requested").length === 1);
    const req = ofTopic(bus.events, "agent.approval_requested")[0]!;
    expect(req).toMatchObject({
      threadId: t.id,
      tool: "Bash",
      input: { command: "rm -rf build" },
      summary: "Bash: rm -rf build",
    });

    const d = await detail(t.id);
    expect(d.running).toBe(true);
    expect(d.pending.approvals.map((a) => a.requestId)).toEqual([req.requestId]);
    expect(d.pending.inputs).toEqual([]);
    const assistant = (await messages(t.id)).find((m) => m.role === "assistant")!;
    expect(assistant.parts).toEqual([
      { type: "tool_use", id: "tu1", name: "Bash", input: { command: "rm -rf build" } },
      {
        type: "approval",
        requestId: req.requestId,
        tool: "Bash",
        input: { command: "rm -rf build" },
        summary: "Bash: rm -rf build",
        decision: "pending",
      },
    ]);

    expect((await decide(t.id, req.requestId, "approve")).status).toBe(200);
    await waitFor(() => ofTopic(bus.events, "agent.done").length === 1);
    expect(ofTopic(bus.events, "agent.approval_resolved")[0]).toMatchObject({
      requestId: req.requestId,
      decision: "approve",
      by: "desktop",
    });
    const after = (await messages(t.id)).find((m) => m.role === "assistant")!;
    expect(after.parts[1]).toMatchObject({ type: "approval", decision: "approve" });
    expect(after.parts[2]).toMatchObject({ type: "tool_result", output: { decision: "approve" } });
    expect(after.contentMd).toBe("ran it");
    expect((await detail(t.id)).pending).toEqual({ approvals: [], inputs: [] });

    // Settled requests answer 409; unknown ones 404.
    expect((await decide(t.id, req.requestId, "deny")).status).toBe(409);
    expect((await decide(t.id, "apr_nope", "approve")).status).toBe(404);
    expect((await decide("th_nope", req.requestId, "approve")).status).toBe(404);
    bus.close();
  });

  test("deny resolves and the run goes on without the call", async () => {
    const t = await newThread();
    const bus = listen("agent.*");
    await bus.ready;
    await send(t.id, "approve:git push --force");
    await waitFor(() => ofTopic(bus.events, "agent.approval_requested").length === 1);
    const req = ofTopic(bus.events, "agent.approval_requested")[0]!;
    expect((await decide(t.id, req.requestId, "deny")).status).toBe(200);
    await waitFor(() => ofTopic(bus.events, "agent.done").length === 1);
    expect(ofTopic(bus.events, "agent.approval_resolved")[0]).toMatchObject({
      decision: "deny",
      by: "desktop",
    });
    expect(ofTopic(bus.events, "agent.done")[0]!.status).toBe("completed");
    const assistant = (await messages(t.id)).find((m) => m.role === "assistant")!;
    expect(assistant.parts[1]).toMatchObject({ type: "approval", decision: "deny" });
    expect(assistant.parts[2]).toMatchObject({ type: "tool_result", isError: true });
    expect(assistant.contentMd).toBe("skipped it");
    bus.close();
  });

  test("nobody answers: the timeout denies", async () => {
    const t = await newThread();
    const bus = listen("agent.*");
    await bus.ready;
    await send(t.id, "approve:make install");
    await waitFor(
      () => ofTopic(bus.events, "agent.approval_resolved").length === 1,
      APPROVAL_TIMEOUT_MS * 8,
    );
    expect(ofTopic(bus.events, "agent.approval_resolved")[0]).toMatchObject({
      decision: "deny",
      by: "timeout",
    });
    await waitFor(() => ofTopic(bus.events, "agent.done").length === 1);
    expect((await messages(t.id)).find((m) => m.role === "assistant")!.parts[1]).toMatchObject({
      type: "approval",
      decision: "deny",
    });
    bus.close();
  });

  test("a paired phone decides over the remote listener, and is credited as the device", async () => {
    const deviceToken = await pairPhone("Maya's iPhone");
    const t = await newThread();
    const phone = listen("agent.*", deviceToken, remoteUrl);
    await phone.ready;
    await send(t.id, "approve:npm publish");
    await waitFor(() => ofTopic(phone.events, "agent.approval_requested").length === 1);
    const req = ofTopic(phone.events, "agent.approval_requested")[0]!;
    // The phone reads the pending list and answers on its own listener with its own token.
    const seen = await json<ThreadDetail>(
      fetch(`${remoteUrl}/threads/${t.id}`, {
        headers: { authorization: `Bearer ${deviceToken}` },
      }),
    );
    expect(seen.pending.approvals[0]?.requestId).toBe(req.requestId);
    const res = await fetch(`${remoteUrl}/threads/${t.id}/approvals/${req.requestId}`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(res.status).toBe(200);
    await waitFor(() => ofTopic(phone.events, "agent.done").length === 1);
    expect(ofTopic(phone.events, "agent.approval_resolved")[0]).toMatchObject({
      decision: "approve",
      by: "device",
    });
    phone.close();
  });
});

describe("questions", () => {
  test("input_requested carries the options; the answer reaches the agent and the part", async () => {
    const t = await newThread();
    const bus = listen("agent.*");
    await bus.ready;
    await send(t.id, "ask");
    await waitFor(() => ofTopic(bus.events, "agent.input_requested").length === 1);
    const req = ofTopic(bus.events, "agent.input_requested")[0]!;
    expect(req).toMatchObject({
      threadId: t.id,
      question: "Which regulator?",
      options: ["LDO", "Buck"],
    });
    expect((await detail(t.id)).pending.inputs.map((i) => i.requestId)).toEqual([req.requestId]);
    expect((await messages(t.id)).find((m) => m.role === "assistant")!.parts[0]).toEqual({
      type: "question",
      requestId: req.requestId,
      question: "Which regulator?",
      options: ["LDO", "Buck"],
      answer: null,
    });

    // Wrong route for the request kind: an approval id is not an input id.
    expect(
      (
        await local(`/threads/${t.id}/approvals/${req.requestId}`, {
          method: "POST",
          body: JSON.stringify({ decision: "approve" }),
        })
      ).status,
    ).toBe(404);
    const res = await local(`/threads/${t.id}/inputs/${req.requestId}`, {
      method: "POST",
      body: JSON.stringify({ answer: "Buck" }),
    });
    expect(res.status).toBe(200);
    await waitFor(() => ofTopic(bus.events, "agent.done").length === 1);
    expect(ofTopic(bus.events, "agent.input_resolved")[0]).toMatchObject({
      requestId: req.requestId,
      answer: "Buck",
    });
    const assistant = (await messages(t.id)).find((m) => m.role === "assistant")!;
    expect(assistant.parts[0]).toMatchObject({ type: "question", answer: "Buck" });
    expect(assistant.contentMd).toBe("you said Buck");
    expect(
      (
        await local(`/threads/${t.id}/inputs/${req.requestId}`, {
          method: "POST",
          body: JSON.stringify({ answer: "LDO" }),
        })
      ).status,
    ).toBe(409);
    bus.close();
  });
});

describe("Claude Code's permission prompt (MCP permission_prompt)", () => {
  async function mcpClient(token: string) {
    const client = new Client({ name: "claude-fake", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${daemon.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    return { client, transport };
  }
  const promptResult = (r: Awaited<ReturnType<Client["callTool"]>>) =>
    JSON.parse((r.content as Array<{ type: string; text: string }>)[0]!.text) as {
      behavior: string;
      updatedInput?: unknown;
      message?: string;
    };

  test("reads and idempotent fabdesk tools are allowed on the spot; writes wait; the token names the run", async () => {
    const t = await newThread();
    const bus = listen("agent.*");
    await bus.ready;
    await send(t.id, "hold:mcp");
    await waitFor(() => sessions.some((s) => s.prompt === "hold:mcp"));
    const session = sessions.find((s) => s.prompt === "hold:mcp")!;
    expect(session.runtimeMode).toBe("supervised");
    const { client, transport } = await mcpClient(session.mcp.token);
    const tools = await client.listTools();
    expect(tools.tools.map((x) => x.name)).toContain("permission_prompt");

    expect(
      promptResult(
        await client.callTool({
          name: "permission_prompt",
          arguments: { tool_name: "Read", input: { file_path: "/x" }, tool_use_id: "a" },
        }),
      ),
    ).toEqual({ behavior: "allow", updatedInput: { file_path: "/x" } });
    expect(
      promptResult(
        await client.callTool({
          name: "permission_prompt",
          arguments: {
            tool_name: "mcp__fabdesk__project_write_file",
            input: { path: "a.json", content: "{}" },
          },
        }),
      ),
    ).toMatchObject({ behavior: "allow" });
    expect(ofTopic(bus.events, "agent.approval_requested")).toHaveLength(0);

    const pending = client.callTool({
      name: "permission_prompt",
      arguments: { tool_name: "Bash", input: { command: "rm -rf /tmp/x" }, tool_use_id: "b" },
    });
    await waitFor(() => ofTopic(bus.events, "agent.approval_requested").length === 1);
    const req = ofTopic(bus.events, "agent.approval_requested")[0]!;
    expect(req.summary).toBe("Bash: rm -rf /tmp/x");
    await decide(t.id, req.requestId, "deny");
    expect(promptResult(await pending)).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("denied"),
    });

    const approved = client.callTool({
      name: "permission_prompt",
      arguments: {
        tool_name: "Write",
        input: { file_path: "/p/a.ts", content: "x" },
        tool_use_id: "c",
      },
    });
    await waitFor(() => ofTopic(bus.events, "agent.approval_requested").length === 2);
    await decide(t.id, ofTopic(bus.events, "agent.approval_requested")[1]!.requestId, "approve");
    expect(promptResult(await approved)).toEqual({
      behavior: "allow",
      updatedInput: { file_path: "/p/a.ts", content: "x" },
    });

    // AskUserQuestion becomes a question; the answer goes back the way Claude expects it.
    const asked = client.callTool({
      name: "permission_prompt",
      arguments: {
        tool_name: "AskUserQuestion",
        input: { questions: [{ question: "Layers?", options: [{ label: "2" }, { label: "4" }] }] },
      },
    });
    await waitFor(() => ofTopic(bus.events, "agent.input_requested").length === 1);
    const q = ofTopic(bus.events, "agent.input_requested")[0]!;
    expect(q).toMatchObject({ question: "Layers?", options: ["2", "4"] });
    await local(`/threads/${t.id}/inputs/${q.requestId}`, {
      method: "POST",
      body: JSON.stringify({ answer: "4" }),
    });
    expect(promptResult(await asked)).toEqual({
      behavior: "allow",
      updatedInput: {
        questions: [{ question: "Layers?", options: [{ label: "2" }, { label: "4" }] }],
        answers: { "Layers?": "4" },
      },
    });

    await transport.terminateSession();
    await client.close();
    release("mcp");
    await waitFor(() => ofTopic(bus.events, "agent.done").length === 1);

    // The daemon token is not a supervised run: that session does not even see the tool, so a
    // model in full mode cannot stumble on it.
    const stray = await mcpClient(daemon.token);
    expect((await stray.client.listTools()).tools.map((x) => x.name)).not.toContain(
      "permission_prompt",
    );
    await stray.transport.terminateSession();
    await stray.client.close();
    bus.close();
  });
});

describe("interactive questions for full-mode agents", () => {
  test("Codex native tools wait for a choice or custom answer, persist it, and never invent timeout answers", async () => {
    const t = await newThread({ agentId: "codex", runtimeMode: "full" });
    const other = await newThread({ runtimeMode: "full" });
    const bus = listen("agent.*");
    await bus.ready;
    await send(t.id, "hold:interactive");
    await waitFor(() => sessions.some((s) => s.prompt === "hold:interactive"));
    const session = sessions.find((s) => s.prompt === "hold:interactive")!;
    const client = new Client({ name: "question-test", version: "0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${daemon.url}/mcp?profile=native`),
      {
        requestInit: { headers: { authorization: `Bearer ${session.mcp.token}` } },
      },
    );
    const result = (r: Awaited<ReturnType<Client["callTool"]>>) =>
      JSON.parse((r.content as Array<{ text: string }>)[0]!.text);
    try {
      await client.connect(transport);
      const names = (await client.listTools()).tools.map((x) => x.name);
      expect(names).toContain("request_user_input");
      expect(names).not.toContain("permission_prompt");
      expect(client.getInstructions()).toContain("Wait for the submitted answer");
      for (const [index, answer] of ["USB", "My own adapter"].entries()) {
        let resolved = false;
        const pending = client
          .callTool({
            name: "request_user_input",
            arguments: { question: "Connect to what?", options: ["USB", "Serial port"] },
          })
          .then((r) => {
            resolved = true;
            return r;
          });
        await waitFor(() => ofTopic(bus.events, "agent.input_requested").length === index + 1);
        const q = ofTopic(bus.events, "agent.input_requested")[index]!;
        expect(resolved).toBe(false);
        expect(q.threadId).toBe(t.id);
        expect(
          (
            await local(`/threads/${other.id}/inputs/${q.requestId}`, {
              method: "POST",
              body: JSON.stringify({ answer }),
            })
          ).status,
        ).toBe(404);
        const stored = (await messages(t.id))
          .flatMap((m) => m.parts ?? [])
          .find((p) => p.type === "question" && p.requestId === q.requestId);
        expect(stored).toMatchObject({
          type: "question",
          answer: null,
          options: ["USB", "Serial port"],
        });
        expect(
          (
            await local(`/threads/${t.id}/inputs/${q.requestId}`, {
              method: "POST",
              body: JSON.stringify({ answer }),
            })
          ).status,
        ).toBe(200);
        expect(result(await pending)).toEqual({ status: "answered", answer });
        const persisted = (await messages(t.id))
          .flatMap((m) => m.parts ?? [])
          .find((p) => p.type === "question" && p.requestId === q.requestId);
        expect(persisted).toMatchObject({ answer });
      }
      const timedOut = result(
        await client.callTool({
          name: "request_user_input",
          arguments: { question: "Unanswered?" },
        }),
      );
      expect(timedOut).toMatchObject({ status: "unanswered", answer: null });
      expect(timedOut.instruction).toContain("Do not guess");
      expect((await detail(t.id)).pending.inputs).toHaveLength(0);

      const stopped = client.callTool({
        name: "request_user_input",
        arguments: { question: "Stop while waiting?" },
      });
      await waitFor(() => ofTopic(bus.events, "agent.input_requested").length === 4);
      await local(`/threads/${t.id}/abort`, { method: "POST" });
      expect(result(await stopped)).toMatchObject({ status: "unanswered", answer: null });
      expect((await detail(t.id)).pending.inputs).toHaveLength(0);
      expect(
        (
          await client.callTool({
            name: "request_user_input",
            arguments: { question: "Too late?" },
          })
        ).isError,
      ).toBe(true);
    } finally {
      await transport.terminateSession();
      await client.close();
      release("interactive");
      bus.close();
    }
    const stray = new Client({ name: "not-a-run", version: "0" });
    await stray.connect(
      new StreamableHTTPClientTransport(new URL(`${daemon.url}/mcp?profile=native`), {
        requestInit: { headers: H() },
      }),
    );
    expect((await stray.listTools()).tools.map((x) => x.name)).not.toContain("request_user_input");
    await stray.close();
  });
});

describe("queued messages (C5)", () => {
  test("queued while a run is live, sent when it ends, removable until then", async () => {
    const t = await newThread({ runtimeMode: "full" });
    const bus = listen("agent.*,thread.*");
    await bus.ready;
    await send(t.id, "hold:queue");
    await waitFor(() => sessions.some((s) => s.prompt === "hold:queue"));

    const first = await send(t.id, "first follow-up", { queue: true });
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as { queued: boolean; messageId: string };
    expect(firstBody.queued).toBe(true);
    const second = await json<{ messageId: string }>(
      local(`/threads/${t.id}/messages?queue=1`, {
        method: "POST",
        body: JSON.stringify({ content: "second follow-up" }),
      }),
    );
    // Without the flag a live run is still a conflict, as before.
    expect((await send(t.id, "not queued")).status).toBe(412);

    const listed = await messages(t.id);
    expect(listed.filter((m) => m.status === "queued").map((m) => m.contentMd)).toEqual([
      "first follow-up",
      "second follow-up",
    ]);
    expect(listed.find((m) => m.contentMd === "hold:queue")!.status).toBeUndefined();

    expect(
      (await local(`/threads/${t.id}/messages/${firstBody.messageId}`, { method: "DELETE" }))
        .status,
    ).toBe(200);
    expect(
      (await local(`/threads/${t.id}/messages/${firstBody.messageId}`, { method: "DELETE" }))
        .status,
    ).toBe(404);
    // A sent message is not removable this way.
    expect(
      (
        await local(
          `/threads/${t.id}/messages/${listed.find((m) => m.contentMd === "hold:queue")!.id}`,
          { method: "DELETE" },
        )
      ).status,
    ).toBe(409);

    release("queue");
    await waitFor(() => ofTopic(bus.events, "agent.started").length === 2);
    await waitFor(() => ofTopic(bus.events, "agent.done").length === 2);
    expect(sessions.map((s) => s.prompt)).toContain("second follow-up");
    const after = await messages(t.id);
    expect(after.some((m) => m.status === "queued")).toBe(false);
    expect(after.map((m) => [m.role, m.contentMd])).toEqual([
      ["user", "hold:queue"],
      ["assistant", "released"],
      ["user", "second follow-up"],
      ["assistant", "echo second follow-up"],
    ]);
    expect(
      (await local(`/threads/${t.id}/messages/${second.messageId}`, { method: "DELETE" })).status,
    ).toBe(409);
    bus.close();
  });

  test("with no run live, queue is just send", async () => {
    const t = await newThread({ runtimeMode: "full" });
    const res = await send(t.id, "plain", { queue: true });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ runId: expect.any(String) });
  });
});

describe("one agent writer per project (#93)", () => {
  test("a second thread on a busy project gets 412 naming the busy thread; nothing is stored", async () => {
    const project = await json<{ id: string }>(
      local("/projects", { method: "POST", body: JSON.stringify({ name: "Lease Board" }) }),
    );
    const a = await newThread({ runtimeMode: "full", projectId: project.id, title: "Holder" });
    const b = await newThread({ runtimeMode: "full", projectId: project.id });
    const scratch = await newThread({ runtimeMode: "full" });
    expect((await send(a.id, "hold:lease")).status).toBe(202);
    await waitFor(() => sessions.some((s) => s.prompt === "hold:lease"));

    // Refused whether or not the client asked to queue: b has no run of its own to drain after.
    for (const extra of [{}, { queue: true }]) {
      const refused = await send(b.id, "second writer", extra);
      expect(refused.status).toBe(412);
      const body = (await refused.json()) as { error: string; code: string; threadId: string };
      expect(body).toMatchObject({ code: "precondition", threadId: a.id });
      expect(body.error).toContain(`"Holder" (${a.id})`);
    }
    expect(await messages(b.id)).toEqual([]);
    // A thread without a project is not affected.
    expect((await send(scratch.id, "scratch")).status).toBe(202);

    // fakeRun ignores abort: Stop answers after the bounded wait, and the lease stays held.
    const stop = await json<{ aborted: boolean; settled: boolean }>(
      local(`/threads/${a.id}/abort`, { method: "POST" }),
    );
    expect(stop).toMatchObject({ aborted: true, settled: false });
    expect((await send(b.id, "still busy")).status).toBe(412);

    // Once the holder's run really ends, the project is free.
    release("lease");
    let running = true;
    for (let i = 0; i < 300 && running; i++) {
      running = (await detail(a.id)).running;
      if (running) await Bun.sleep(10);
    }
    expect(running).toBe(false);
    expect((await send(b.id, "now it is free")).status).toBe(202);
  });
});
