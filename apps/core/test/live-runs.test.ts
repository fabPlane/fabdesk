import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentRun, AgentSession } from "@fabdesk/agents";
import type { CoreServices } from "@fabdesk/tools";
import { serve, type Daemon } from "../src/serve";
import { mockServices } from "../../../packages/tools/test/mock-services";

let daemon: Daemon;
let release: () => void = () => {};

/** An agent that says hello and then waits until the test lets it finish. */
async function* gatedEvents(): AsyncGenerator<AgentEvent> {
  yield { type: "init", sessionId: "sess-1", mcpServers: [] };
  yield { type: "text", delta: "working" };
  await new Promise<void>((r) => (release = r));
  yield { type: "done", exitCode: 0, sessionId: "sess-1" };
}

beforeAll(async () => {
  const home = await mkdtemp(join(tmpdir(), "fabdesk-live-runs-"));
  process.env["FABDESK_PROJECTS_DIR"] = join(home, "Fabdesk");
  process.env["FABDESK_TOKEN"] = "test-token-0123456789abcdef";
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
        bus: { emit: (e) => bus.emit(e) },
        routeRuns: store.routeRuns,
      }) as unknown as CoreServices,
    adapters: {
      claude: {
        id: "claude",
        run: (_session: AgentSession): AgentRun => ({ events: gatedEvents(), abort() {} }),
      },
    },
  });
});

afterAll(async () => {
  await daemon.close("tests done");
});

const api = (path: string, init?: RequestInit) =>
  fetch(`${daemon.url}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${daemon.token}`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

test("GET /runs/live lists the run in progress and empties once it is done", async () => {
  expect(await (await api("/runs/live")).json()).toEqual([]);
  const thread = (await (
    await api("/threads", { method: "POST", body: JSON.stringify({ agentId: "claude" }) })
  ).json()) as { id: string };
  await api(`/threads/${thread.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ content: "go" }),
  });
  const live = (await (await api("/runs/live")).json()) as Array<{
    runId: string;
    threadId: string;
    agentId: string;
    startedAt: string;
  }>;
  expect(live).toHaveLength(1);
  expect(live[0]).toMatchObject({ threadId: thread.id, agentId: "claude" });
  expect(live[0]!.runId).toMatch(/^run_/);
  expect(Date.parse(live[0]!.startedAt)).toBeGreaterThan(0);
  release();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && ((await (await api("/runs/live")).json()) as unknown[]).length)
    await Bun.sleep(20);
  expect(await (await api("/runs/live")).json()).toEqual([]);
});
