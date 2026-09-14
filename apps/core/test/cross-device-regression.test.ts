import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentRun, AgentSession } from "@fabdesk/agents";
import type { CoreEvent } from "@fabdesk/protocol";
import type { CoreServices } from "@fabdesk/tools";
import { serve, type Daemon } from "../src/serve";
import { mockServices } from "../../../packages/tools/test/mock-services";

let daemon: Daemon;
let release: () => void = () => {};

async function* gatedAgent(): AsyncGenerator<AgentEvent> {
  yield { type: "init", sessionId: "cross-device-session", mcpServers: [] };
  yield { type: "text", delta: "working from the other device" };
  await new Promise<void>((resolve) => (release = resolve));
  yield { type: "done", exitCode: 0, sessionId: "cross-device-session" };
}

beforeAll(async () => {
  const home = await mkdtemp(join(tmpdir(), "fabdesk-cross-device-"));
  await Bun.write(join(home, ".fabdesk-dev"), "");
  process.env["FABDESK_PROJECTS_DIR"] = join(home, "projects");
  process.env["FABDESK_TOKEN"] = "cross-device-test-token-0123456789";
  daemon = await serve({
    port: 0,
    dataDir: home,
    handshakeFile: join(home, "daemon.json"),
    localAuth: true,
    quiet: true,
    watchProjects: false,
    services: async ({ projects, bus, store }) =>
      mockServices([], {
        projects,
        bus: { emit: (event) => bus.emit(event) },
        routeRuns: store.routeRuns,
      }) as unknown as CoreServices,
    adapters: {
      claude: {
        id: "claude",
        run: (_session: AgentSession): AgentRun => ({ events: gatedAgent(), abort() {} }),
      },
    },
  });
});

afterAll(async () => daemon.close("cross-device test done"));

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${daemon.url}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${daemon.token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

async function eventReader(signal: AbortSignal) {
  const response = await fetch(
    `${daemon.url}/events?token=${daemon.token}&topics=agent.*,thread.*`,
    {
      signal,
    },
  );
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return async (topic: CoreEvent["topic"], timeoutMs = 5_000): Promise<CoreEvent> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) break;
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (!data) continue;
        const event = JSON.parse(data) as CoreEvent;
        if (event.topic === topic) return event;
      }
      const remaining = deadline - Date.now();
      const chunk = await Promise.race([
        reader.read(),
        Bun.sleep(remaining).then(() => ({ done: true as const, value: undefined })),
      ]);
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
    }
    throw new Error(`timed out waiting for ${topic}`);
  };
}

test("a run crosses devices and a reconnect recovers the complete terminal state", async () => {
  const desktopAbort = new AbortController();
  const phoneAbort = new AbortController();
  const desktop = await eventReader(desktopAbort.signal);
  const phone = await eventReader(phoneAbort.signal);

  const thread = (await (
    await api("/threads", { method: "POST", body: JSON.stringify({ agentId: "claude" }) })
  ).json()) as { id: string };
  await api(`/threads/${thread.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ content: "make the board" }),
  });

  const [desktopStarted, phoneStarted] = await Promise.all([
    desktop("agent.started"),
    phone("agent.started"),
  ]);
  expect(desktopStarted).toMatchObject({ threadId: thread.id });
  expect(phoneStarted).toMatchObject({ threadId: thread.id });
  expect((await (await api("/runs/live")).json()) as unknown[]).toHaveLength(1);

  // Desktop disappears mid-run; the phone continues receiving the terminal event.
  desktopAbort.abort();
  release();
  expect(await phone("agent.done")).toMatchObject({ threadId: thread.id });
  expect(await (await api("/runs/live")).json()).toEqual([]);

  // What a reconnected desktop refetches contains both sides of the conversation, not merely the
  // assistant delta that happened to arrive over its old event stream.
  const messages = (await (await api(`/threads/${thread.id}/messages`)).json()) as Array<{
    role: string;
    contentMd: string;
  }>;
  expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  expect(messages[0]!.contentMd).toBe("make the board");
  expect(messages[1]!.contentMd).toBe("working from the other device");
  phoneAbort.abort();
}, 15_000);
