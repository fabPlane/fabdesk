import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentRun, AgentSession } from "@fabdesk/agents";
import type { FinishItSession } from "@fabdesk/protocol";
import type { CoreServices } from "@fabdesk/tools";
import { serve, type Daemon } from "../src/serve";
import { mockServices } from "../../../packages/tools/test/mock-services";

const NETLIST = {
  netlist: {
    components: [{ ref: "R1", value: "1k", footprint: "Resistor_SMD:R_0402_1005Metric" }],
    nets: [{ name: "N1", nodes: [{ ref: "R1", pin: "1" }] }],
  },
};

let hangRelease: (() => void) | null = null;
let hangAbort = false;
let lastPrompt: string | null = null;
let mode: "hang" | "complete" | "quick" = "quick";

async function* hangEvents(): AsyncGenerator<AgentEvent> {
  hangAbort = false;
  yield { type: "init", sessionId: "fin-hang", mcpServers: [] };
  yield { type: "text", delta: "Finishing the board" };
  await new Promise<void>((resolve) => {
    hangRelease = resolve;
  });
  yield { type: "done", exitCode: hangAbort ? 1 : 0, sessionId: "fin-hang" };
}

async function* completeEvents(session: AgentSession): AsyncGenerator<AgentEvent> {
  lastPrompt = session.prompt;
  await writeFile(join(session.cwd, "circuit.netlist.json"), JSON.stringify(NETLIST));
  await writeFile(join(session.cwd, "board.kicad_pcb"), "(kicad_pcb (version 20240101))\n");
  await mkdir(join(session.cwd, "reports"), { recursive: true });
  await writeFile(join(session.cwd, "reports", "route.json"), JSON.stringify({ ok: true, open: 0 }));
  await writeFile(
    join(session.cwd, "reports", "drc.json"),
    JSON.stringify({ counts: { errors: 0, warnings: 0, unconnected: 0 } }),
  );
  yield { type: "init", sessionId: "fin-ok", mcpServers: [] };
  yield { type: "tool_use", id: "t1", name: "circuit_build", input: {} };
  yield { type: "tool_result", id: "t1", output: { ok: true } };
  yield { type: "tool_use", id: "t2", name: "route_run", input: {} };
  yield { type: "tool_result", id: "t2", output: { ok: true } };
  yield { type: "tool_use", id: "t3", name: "verify_drc", input: {} };
  yield { type: "tool_result", id: "t3", output: { ok: true } };
  yield { type: "done", exitCode: 0, sessionId: "fin-ok" };
}

async function* quickEvents(): AsyncGenerator<AgentEvent> {
  yield { type: "init", sessionId: "fin-q", mcpServers: [] };
  yield { type: "text", delta: "ok" };
  yield { type: "done", exitCode: 0, sessionId: "fin-q" };
}

let daemon: Daemon;
let home: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "fabdesk-finish-it-http-"));
  process.env["FABDESK_PROJECTS_DIR"] = join(home, "Fabdesk");
  process.env["FABDESK_TOKEN"] = "test-token-finish-it-01234567";
  process.env["FABDESK_CHANNEL"] = "internal";
  daemon = await serve({
    port: 0,
    dataDir: home,
    handshakeFile: join(home, "daemon.json"),
    localAuth: true,
    parentPid: process.pid,
    quiet: true,
    watchProjects: false,
    abortSettleTimeoutMs: 200,
    services: async ({ projects, bus, store }) =>
      mockServices([], {
        projects,
        bus: { emit: (e) => bus.emit(e) },
        routeRuns: store.routeRuns,
        channel: "internal",
      }) as unknown as CoreServices,
    adapters: {
      claude: {
        id: "claude",
        run: (session: AgentSession): AgentRun => {
          lastPrompt = session.prompt;
          if (mode === "hang")
            return {
              events: hangEvents(),
              abort() {
                hangAbort = true;
                hangRelease?.();
              },
            };
          if (mode === "complete")
            return { events: completeEvents(session), abort() {} };
          return { events: quickEvents(), abort() {} };
        },
      },
    },
    doctor: async () => ({
      version: "t",
      channel: "internal",
      bun: Bun.version,
      platform: "test",
      kicad: { found: false },
      ngspice: { found: false },
      routers: [],
      agents: [],
      warnings: [],
    }),
  });
});

afterAll(async () => {
  hangRelease?.();
  await daemon.close("tests done");
});

const H = () => ({ authorization: `Bearer ${daemon.token}` });
const api = (path: string, init: RequestInit = {}) =>
  fetch(`${daemon.url}${path}`, {
    ...init,
    headers: { ...H(), "content-type": "application/json", ...(init.headers ?? {}) },
  });

async function createProject(name: string): Promise<{ id: string; path: string }> {
  return (await (await api("/projects", { method: "POST", body: JSON.stringify({ name }) })).json()) as {
    id: string;
    path: string;
  };
}

async function waitForSession(
  projectId: string,
  pred: (s: FinishItSession | null) => boolean,
  ms = 4000,
): Promise<FinishItSession | null> {
  const deadline = Date.now() + ms;
  let session: FinishItSession | null = null;
  while (Date.now() < deadline) {
    const body = (await (await api(`/projects/${projectId}/finish-it`)).json()) as {
      session: FinishItSession | null;
    };
    session = body.session;
    if (pred(session)) return session;
    await Bun.sleep(25);
  }
  return session;
}

describe("finish-it HTTP", () => {
  test("GET is null before a run; 404 for an unknown project", async () => {
    const project = await createProject("Idle Board");
    expect((await (await api(`/projects/${project.id}/finish-it`)).json()) as { session: null }).toEqual({
      session: null,
    });
    expect((await api("/projects/missing/finish-it")).status).toBe(404);
  });

  test("already-manufacturable project completes without waiting on the agent", async () => {
    const project = await createProject("Done Board");
    await writeFile(join(project.path, "circuit.netlist.json"), JSON.stringify(NETLIST));
    await writeFile(join(project.path, "board.kicad_pcb"), "(kicad_pcb)\n");
    await mkdir(join(project.path, "reports"), { recursive: true });
    await writeFile(join(project.path, "reports", "route.json"), JSON.stringify({ ok: true, open: 0 }));
    await writeFile(
      join(project.path, "reports", "drc.json"),
      JSON.stringify({ counts: { errors: 0, warnings: 0, unconnected: 0 } }),
    );
    const started = await api(`/projects/${project.id}/finish-it`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(started.status).toBe(202);
    const body = (await started.json()) as { session: FinishItSession };
    expect(body.session.status).toBe("completed");
    expect(body.session.milestones.every((m) => m.status === "skipped" || m.status === "done")).toBe(
      true,
    );
  });

  test("drives the agent, reports milestones, and commits when files appear", async () => {
    mode = "complete";
    const project = await createProject("Partial Board");
    const started = await api(`/projects/${project.id}/finish-it`, {
      method: "POST",
      body: JSON.stringify({ agentId: "claude" }),
    });
    expect(started.status).toBe(202);
    const session = await waitForSession(project.id, (s) => s?.status === "completed");
    expect(session?.status).toBe("completed");
    expect(lastPrompt).toContain("Finish it mode");
    expect(lastPrompt).toContain("circuit_build");
    expect(session?.milestones.find((m) => m.id === "schematic")?.status).toBe("done");
    expect(session?.milestones.find((m) => m.id === "build")?.status).toBe("done");
    expect(session?.commits.length).toBeGreaterThan(0);
    expect(session?.threadId).toBeString();
    const log = Bun.spawn(["git", "-C", project.path, "log", "--pretty=%s"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const messages = await new Response(log.stdout).text();
    expect(messages).toContain("finish-it:");
  });

  test("an agent that makes no progress on failing DRC fails instead of completing", async () => {
    mode = "quick";
    const project = await createProject("Stuck DRC Board");
    await writeFile(join(project.path, "circuit.netlist.json"), JSON.stringify(NETLIST));
    await writeFile(join(project.path, "board.kicad_pcb"), "(kicad_pcb)\n");
    await mkdir(join(project.path, "reports"), { recursive: true });
    await writeFile(join(project.path, "reports", "route.json"), JSON.stringify({ ok: true, open: 0 }));
    await writeFile(
      join(project.path, "reports", "drc.json"),
      JSON.stringify({ counts: { errors: 4, warnings: 0, unconnected: 0 } }),
    );
    const started = await api(`/projects/${project.id}/finish-it`, {
      method: "POST",
      body: JSON.stringify({ agentId: "claude" }),
    });
    expect(started.status).toBe(202);
    expect(((await started.json()) as { session: FinishItSession }).session.status).toBe("running");
    const session = await waitForSession(
      project.id,
      (s) => s?.status === "completed" || s?.status === "failed" || s?.status === "stopped",
      8000,
    );
    expect(session?.status).toBe("failed");
    expect(session?.error).toContain("verify");
    const verify = session?.milestones.find((m) => m.id === "verify");
    expect(verify?.status).toBe("failed");
    expect(verify?.note).toContain("DRC 4 errors");
    expect(session?.milestones.some((m) => m.status === "running")).toBe(false);
  });

  test("stop aborts a live run and does not start a follow-up", async () => {
    mode = "hang";
    hangRelease = null;
    const project = await createProject("Stop Board");
    const started = await api(`/projects/${project.id}/finish-it`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(started.status).toBe(202);
    expect(((await started.json()) as { session: FinishItSession }).session.status).toBe("running");
    await waitForSession(project.id, (s) => s?.status === "running" && !!s.runId);
    const stopped = await api(`/projects/${project.id}/finish-it/stop`, { method: "POST" });
    expect(stopped.status).toBe(200);
    const session = await waitForSession(
      project.id,
      (s) => s?.status === "stopped" || s?.status === "failed",
    );
    expect(session?.status).toBe("stopped");
    const again = await api(`/projects/${project.id}/finish-it`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(again.status).toBe(202);
  });

  test("a second start while running is 412", async () => {
    mode = "hang";
    hangRelease = null;
    const project = await createProject("Busy Board");
    expect(
      (
        await api(`/projects/${project.id}/finish-it`, {
          method: "POST",
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(202);
    await waitForSession(project.id, (s) => s?.status === "running");
    expect(
      (
        await api(`/projects/${project.id}/finish-it`, {
          method: "POST",
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(412);
    await api(`/projects/${project.id}/finish-it/stop`, { method: "POST" });
    await waitForSession(project.id, (s) => s?.status === "stopped" || s?.status === "failed");
  });
});
