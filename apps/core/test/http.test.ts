import { WorkingDesigns } from "../src/working-design";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PrivacyStatus } from "@fabdesk/protocol";
import type { AgentEvent, AgentRun, AgentSession } from "@fabdesk/agents";
import { snapshotProjectDependencies, type CoreServices } from "@fabdesk/tools";
import { serve, type Daemon } from "../src/serve";
import { SettingsRepo } from "../src/db";
import { mockServices } from "../../../packages/tools/test/mock-services";

let daemon: Daemon;
let home: string;
let services: ReturnType<typeof mockServices>;
let lastSession: AgentSession | null = null;

async function* fakeEvents(): AsyncGenerator<AgentEvent> {
  yield {
    type: "init",
    sessionId: "sess-42",
    mcpServers: [{ name: "fabdesk", status: "connected" }],
  };
  yield { type: "text", delta: "Hello " };
  yield { type: "tool_use", id: "tu1", name: "mcp__fabdesk__project_status", input: {} };
  yield { type: "tool_result", id: "tu1", output: { ok: true } };
  yield { type: "text", delta: "world" };
  yield { type: "usage", inputTokens: 10, outputTokens: 5, costUsd: 0.001 };
  yield { type: "done", exitCode: 0, sessionId: "sess-42" };
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "fabdesk-core-"));
  process.env["FABDESK_PROJECTS_DIR"] = join(home, "Fabdesk");
  process.env["FABDESK_TOKEN"] = "test-token-0123456789abcdef";
  process.env["FABDESK_CHANNEL"] = "internal";
  process.env["FABDESK_RUNTIME_ID"] = "runtime-123456789";
  daemon = await serve({
    port: 0,
    dataDir: home,
    handshakeFile: join(home, "daemon.json"),
    localAuth: true,
    parentPid: process.pid,
    quiet: true,
    watchProjects: false,
    services: async ({ projects, bus, store }) => {
      services = mockServices([], {
        projects,
        bus: { emit: (e) => bus.emit(e) },
        routeRuns: store.routeRuns,
        channel: "internal",
      });
      return services as unknown as CoreServices;
    },
    adapters: {
      claude: {
        id: "claude",
        run: (session: AgentSession): AgentRun => {
          lastSession = session;
          return { events: fakeEvents(), abort() {} };
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
  await daemon.close("tests done");
});

const H = () => ({ authorization: `Bearer ${daemon.token}` });
const api = (path: string, init: RequestInit = {}) =>
  fetch(`${daemon.url}${path}`, {
    ...init,
    headers: { ...H(), "content-type": "application/json", ...(init.headers ?? {}) },
  });

describe("http daemon", () => {
  test.each(["%0A", "%0D", "%E2%80%A8", "%E2%80%A9"])("encoded line terminators %s cannot bypass origin or bearer middleware", async encoded => {
    const url = `${daemon.url}/projects/missing${encoded}project`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(url, { headers: { ...H(), origin: "https://evil.example" } })).status).toBe(403);
    // An authenticated, allowed-origin request still reaches the normal not-found response.
    expect((await fetch(url, { headers: H() })).status).toBe(404);
  });

  test("effort saves preserve concurrent model choices and unrelated agent settings", async () => {
    const before = daemon.store.settings.get();
    try {
      daemon.store.settings.patch({ defaultAgent: "claude", agents: {
        codex: { binaryPath: "custom-codex", model: "old", permissionMode: "bypass", pickerModels: ["custom"] },
        claude: { model: "sonnet", effort: "low" },
      } });
      const configured = daemon.store.settings.get();
      const responses = await Promise.all([
        api("/settings/agent-preference", { method: "PUT", body: JSON.stringify({ agentId: "codex", model: "new" }) }),
        api("/settings/agent-effort", { method: "PUT", body: JSON.stringify({ agentId: "codex", effort: "high" }) }),
      ]);
      expect(responses.map((r) => r.status)).toEqual([200, 200]);
      const saved = new SettingsRepo(daemon.store.db).get();
      expect(saved.defaultAgent).toBe("codex");
      expect(saved.agents.codex).toEqual({ ...configured.agents.codex, model: "new", effort: "high" });
      expect(saved.agents.claude).toEqual(configured.agents.claude);
      const reset = await api("/settings/agent-effort", { method: "PUT", body: JSON.stringify({ agentId: "codex", effort: null }) });
      expect(reset.status).toBe(200);
      expect((await reset.json()).agents.codex.effort).toBeNull();
      const valid = daemon.store.settings.get();
      for (const input of [{ agentId: "unknown", effort: "high" }, { agentId: "codex", effort: "invalid" }, { agentId: "codex" }]) {
        expect((await api("/settings/agent-effort", { method: "PUT", body: JSON.stringify(input) })).status).toBe(400);
        expect(daemon.store.settings.get()).toEqual(valid);
      }
    } finally { daemon.store.settings.patch(before); }
  });

  test("composer preferences persist without changing threads or other agent settings", async () => {
    const before = daemon.store.settings.get();
    const thread = daemon.store.threads.create({ agentId: "claude", model: "original-model" });
    try {
      daemon.store.settings.patch({
        agents: {
          codex: { binaryPath: "custom-codex", model: "old-model", permissionMode: "bypass", extraAllowedTools: ["tool_a"], pickerModels: ["model-a"] },
          claude: { binaryPath: "custom-claude", model: "claude-model" },
        },
      });
      const configured = daemon.store.settings.get();
      const response = await api("/settings/agent-preference", {
        method: "PUT", body: JSON.stringify({ agentId: "codex", model: "model-b" }),
      });
      expect(response.status).toBe(200);
      const saved = await response.json();
      expect(saved.defaultAgent).toBe("codex");
      expect(saved.agents.codex).toEqual({ ...configured.agents.codex, model: "model-b" });
      expect(saved.agents.claude).toEqual(configured.agents.claude);
      // A fresh repository reads the committed preference, not the in-memory cache.
      expect(new SettingsRepo(daemon.store.db).get()).toEqual(saved);
      expect(daemon.store.threads.get(thread.id)).toMatchObject({ agentId: "claude", model: "original-model" });

      const resetModel = await api("/settings/agent-preference", {
        method: "PUT", body: JSON.stringify({ agentId: "codex", model: null }),
      });
      expect((await resetModel.json()).agents.codex.model).toBeNull();
      const addAgent = await api("/settings/agent-preference", {
        method: "PUT", body: JSON.stringify({ agentId: "grok", model: "grok-model" }),
      });
      expect(addAgent.status).toBe(200);
      expect((await addAgent.json()).agents.grok).toMatchObject({ model: "grok-model", permissionMode: "acceptEdits" });
      const valid = daemon.store.settings.get();
      for (const input of [{ agentId: "unknown", model: null }, { agentId: "codex", model: 42 }, { agentId: "codex" }]) {
        expect((await api("/settings/agent-preference", { method: "PUT", body: JSON.stringify(input) })).status).toBe(400);
        expect(daemon.store.settings.get()).toEqual(valid);
      }
    } finally {
      daemon.store.settings.patch(before);
      daemon.store.threads.delete(thread.id);
    }
  });

  test("thread snapshots retain timing for older replies and copied branch history", async () => {
    const store = daemon.store;
    const thread = store.threads.create({ agentId: "claude" });
    const older = store.runs.create({ threadId: thread.id, agentId: "claude" });
    store.runs.finish(older.id, { status: "completed", exitCode: 0 });
    store.db.run("UPDATE runs SET started_at = ?, ended_at = ? WHERE id = ?", ["2026-10-19T10:00:00Z", "2026-10-19T10:07:05Z", older.id]);
    const reply = store.threads.addMessage({ threadId: thread.id, role: "assistant", contentMd: "Earlier reply", runId: older.id });
    // Multiple messages for one run must not duplicate its history entry.
    store.threads.addMessage({ threadId: thread.id, role: "assistant", contentMd: "More details", runId: older.id });
    const latest = store.runs.create({ threadId: thread.id, agentId: "claude" });
    store.runs.finish(latest.id, { status: "aborted" });
    store.db.run("UPDATE runs SET started_at = ?, ended_at = ? WHERE id = ?", ["2026-10-19T11:00:00Z", "2026-10-19T11:00:12Z", latest.id]);
    store.threads.addMessage({ threadId: thread.id, role: "assistant", contentMd: "Stopped reply", runId: latest.id });
    const unrelated = store.threads.create({ agentId: "claude" });
    store.runs.create({ threadId: unrelated.id, agentId: "claude" });

    for (let read = 0; read < 2; read++) {
      const snapshot = await (await api(`/threads/${thread.id}`)).json();
      expect(snapshot.run.id).toBe(latest.id);
      expect(snapshot.runs).toHaveLength(2);
      expect(snapshot.runs.find((run: { id: string }) => run.id === older.id)).toMatchObject({
        startedAt: "2026-10-19T10:00:00Z", endedAt: "2026-10-19T10:07:05Z", status: "completed",
      });
    }
    const branch = store.threads.create({ agentId: "claude", parentThreadId: thread.id, branchFromMessageId: reply.id });
    const snapshot = await (await api(`/threads/${branch.id}`)).json();
    expect(snapshot.run).toBeNull();
    expect(snapshot.runs.map((run: { id: string }) => run.id)).toEqual([older.id]);
    expect((await api("/threads/missing-history")).status).toBe(404);
  });

  test("stale project and parent chat return actionable codes instead of SQLite errors", async () => {
    for (const [input, code] of [
      [{ agentId: "claude", projectId: "prj_missing" }, "project_not_found"],
      [{ agentId: "claude", parentThreadId: "th_missing" }, "parent_thread_not_found"],
    ] as const) {
      const before = await (await api("/threads")).json() as unknown[];
      const response = await api("/threads", { method: "POST", body: JSON.stringify(input) });
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.code).toBe(code);
      expect(body.error).not.toContain("FOREIGN KEY");
      expect((await (await api("/threads")).json() as unknown[]).length).toBe(before.length);
    }
  });
  test("health open, auth required, foreign origin rejected, handshake written", async () => {
    const health = await fetch(`${daemon.url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      ok: true,
      mcpSessions: 0,
      runtimeId: "runtime-123456789",
    });
    expect((await fetch(`${daemon.url}/projects`)).status).toBe(401);
    expect(
      (await fetch(`${daemon.url}/projects`, { headers: { authorization: "Bearer wrong" } }))
        .status,
    ).toBe(401);
    expect(
      (
        await fetch(`${daemon.url}/projects`, {
          headers: { ...H(), origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await fetch(`${daemon.url}/health`, { headers: { origin: "https://evil.example" } })).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${daemon.url}/projects`, {
          headers: { ...H(), origin: "http://localhost:5173" },
        })
      ).status,
    ).toBe(200);
    expect(
      (await fetch(`${daemon.url}/projects`, { headers: { ...H(), origin: "app://fabdesk" } }))
        .status,
    ).toBe(200);
    expect(
      (await fetch(`${daemon.url}/projects`, { headers: { ...H(), origin: "null" } })).status,
    ).toBe(200);
    const hs = JSON.parse(await Bun.file(join(home, "daemon.json")).text()) as {
      port: number;
      token: string;
      pid: number;
      authMode: string;
      runtimeId: string;
    };
    expect(hs.port).toBe(daemon.port);
    expect(hs.token).toBe(daemon.token);
    expect(hs.pid).toBe(process.pid);
    expect(hs.authMode).toBe("local");
    expect(hs.runtimeId).toBe("runtime-123456789");
    const me = (await (await api("/v1/auth/me")).json()) as {
      mode: string;
      principal: { subject: string };
    };
    expect(me.mode).toBe("local");
    expect(me.principal.subject).toBe("local:dev");
  });

  test("board-source inspection reads explicit membership and fails closed on invalid manifests", async () => {
    const created = await api("/projects", { method: "POST", body: JSON.stringify({ name: "Assembly inspection" }) });
    const project = await created.json() as { id: string; path: string };
    const endpoint = `/projects/${project.id}/board-sources`;
    expect((await api("/projects/missing-project/board-sources")).status).toBe(404);
    const empty = await (await api(endpoint)).json() as { mode: string; sources: Array<{ status: string }> };
    expect(empty.mode).toBe("single"); expect(empty.sources[0]?.status).toBe("missing");
    await mkdir(join(project.path, "boards", "io"), { recursive: true });
    await writeFile(join(project.path, "boards", "io", "board.kicad_pcb"), "(kicad_pcb)");
    await writeFile(join(project.path, "fabplane.assembly.json"), JSON.stringify({
      contract: "fabplane.assembly.v1", sources: [{ id: "io", name: "I/O", location: "project", directory: "boards/io" }],
      instances: [{ id: "io-1", sourceId: "io", name: "I/O main" }], connections: [],
    }));
    const response = await api(endpoint); expect(response.status).toBe(200);
    const assembly = await response.json() as { mode: string; editing: string; sources: Array<{ pcbPath: string; status: string }> };
    expect(assembly.mode).toBe("assembly"); expect(assembly.editing).toBe("explicit-source-tools");
    expect(assembly.sources[0]?.status).toBe("available"); expect(assembly.sources[0]?.pcbPath).toBe("boards/io/board.kicad_pcb");
    await writeFile(join(project.path, "fabplane.assembly.json"), "{}");
    expect((await api(endpoint)).status).toBe(400);
  });

  test("projects CRUD, files, sketches and project.changed over SSE with catch-up", async () => {
    // Open SSE first so the create event is observed live.
    const sse = await fetch(`${daemon.url}/events?token=${daemon.token}&topics=project.*,job.*`);
    expect(sse.status).toBe(200);
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    const reader = sse.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const readUntil = async (pred: (s: string) => boolean) => {
      const deadline = Date.now() + 3000;
      while (!pred(buf) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
      }
      return buf;
    };

    const created = await api("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Blinky Board" }),
    });
    expect(created.status).toBe(201);
    const project = (await created.json()) as {
      id: string;
      path: string;
      manifest: { board: { layers: number } };
      files: Array<{ path: string }>;
    };
    expect(project.path).toBe(join(home, "Fabdesk", "blinky-board"));
    expect(project.files.map((f) => f.path)).not.toContain("circuit.netlist.json");
    await readUntil((s) => s.includes('\"topic\":\"project.changed\"'));
    expect(buf).toContain(`"projectId":"${project.id}"`);
    const idMatch = /id: (\d+)\ndata: [^\n]*"topic":"project.changed"/.exec(buf);
    expect(idMatch).not.toBeNull();
    reader.cancel();

    // Duplicate names get a suffixed slug.
    const dup = (await (
      await api("/projects", { method: "POST", body: JSON.stringify({ name: "Blinky Board" }) })
    ).json()) as { path: string };
    expect(dup.path).toBe(join(home, "Fabdesk", "blinky-board-2"));

    // Catch-up: reconnect with Last-Event-ID before the create event replays it.
    const catchup = await fetch(
      `${daemon.url}/events?token=${daemon.token}&topics=project.changed`,
      { headers: { "last-event-id": String(Number(idMatch![1]) - 1) } },
    );
    const r2 = catchup.body!.getReader();
    let buf2 = "";
    const deadline = Date.now() + 2000;
    while (!buf2.includes(`"projectId":"${project.id}"`) && Date.now() < deadline) {
      const { value, done } = await r2.read();
      if (done) break;
      buf2 += dec.decode(value);
    }
    expect(buf2).toMatch(new RegExp(`id: ${idMatch![1]}\\ndata: [^\\n]*"topic":"project.changed"`));
    r2.cancel();

    // Files: read, write, jail.
    const missingNetlist = await api(`/projects/${project.id}/files/circuit.netlist.json`);
    expect(missingNetlist.status).toBe(404);
    const put = await api(`/projects/${project.id}/files/notes/readme.md`, {
      method: "PUT",
      body: "# hi",
      headers: { "content-type": "text/markdown" },
    });
    expect(put.status).toBe(200);
    expect(await (await api(`/projects/${project.id}/files/notes/readme.md`)).text()).toBe("# hi");
    expect((await api(`/projects/${project.id}/files/..%2F..%2Fetc%2Fpasswd`)).status).toBe(400);
    expect(
      (await api(`/projects/${project.id}/files/fabdesk.json`, { method: "PUT", body: "{}" }))
        .status,
    ).toBe(400);

    // Sketch upload (multipart PNG) + non-image rejection.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const form = new FormData();
    form.append("file", new Blob([png], { type: "image/png" }), "front.png");
    const up = await fetch(`${daemon.url}/projects/${project.id}/sketches`, {
      method: "POST",
      headers: H(),
      body: form,
    });
    expect(up.status).toBe(201);
    expect(((await up.json()) as { path: string }).path).toBe("sketches/front.png");
    const bad = new FormData();
    bad.append(
      "file",
      new Blob([new TextEncoder().encode("not an image")], { type: "text/plain" }),
      "x.txt",
    );
    expect(
      (
        await fetch(`${daemon.url}/projects/${project.id}/sketches`, {
          method: "POST",
          headers: H(),
          body: bad,
        })
      ).status,
    ).toBe(415);
    const sketches = (await (await api(`/projects/${project.id}/sketches`)).json()) as Array<{
      path: string;
    }>;
    expect(sketches.map((s) => s.path)).toEqual(["sketches/front.png"]);

    // Original editable source bytes and collision naming survive without becoming a PNG.
    const drawing = '{\n "type": "excalidraw", "version": 2, "elements": [{"id":"kept","type":"rectangle"}], "custom": "untouched"\n}\n';
    const uploadDrawing = (body: string, name = "front.excalidraw") => {
      const form = new FormData(); form.append("file", new Blob([body], { type: "application/vnd.excalidraw+json" }), name);
      return fetch(`${daemon.url}/projects/${project.id}/sketches`, { method: "POST", headers: H(), body: form });
    };
    const source = await uploadDrawing(drawing, "../../front.excalidraw");
    expect(source.status).toBe(201);
    expect(((await source.json()) as { path: string }).path).toBe("sketches/front.excalidraw");
    expect(await (await api(`/projects/${project.id}/files/sketches/front.excalidraw`)).text()).toBe(drawing);
    const duplicate = await uploadDrawing(drawing);
    expect(duplicate.status).toBe(201);
    expect(((await duplicate.json()) as { path: string }).path).toBe("sketches/front-2.excalidraw");
    expect((await uploadDrawing("not json")).status).toBe(415);
    expect((await uploadDrawing('{"type":"excalidrawlib","version":2,"elements":[]}')).status).toBe(415);
    expect((await uploadDrawing(" ".repeat(10 * 1024 * 1024 + 1))).status).toBe(413);

    // PATCH manifest + settings
    const patched = (await (
      await api(`/projects/${project.id}`, {
        method: "PATCH",
        body: JSON.stringify({ manifest: { board: { layers: 4 } } }),
      })
    ).json()) as { manifest: { board: { layers: number } } };
    expect(patched.manifest.board.layers).toBe(4);
    const settings = (await (
      await api("/settings", { method: "PATCH", body: JSON.stringify({ keepCoreRunning: true }) })
    ).json()) as { keepCoreRunning: boolean };
    expect(settings.keepCoreRunning).toBe(true);
    // A partial patch leaves the other keys alone (the schema's defaults must not bleed in).
    const themed = (await (
      await api("/settings", { method: "PATCH", body: JSON.stringify({ theme: "dark" }) })
    ).json()) as { keepCoreRunning: boolean; theme: string };
    expect(themed).toMatchObject({ keepCoreRunning: true, theme: "dark" });
    const privacy = await api("/privacy");
    expect(privacy.status).toBe(200);
    expect(PrivacyStatus.safeParse(await privacy.json()).success).toBe(true);
    expect(
      (await api("/settings", { method: "PATCH", body: JSON.stringify({ router: "nope" }) }))
        .status,
    ).toBe(400);

    // Tools over HTTP: sync + job.
    const status = await api("/tools/project_status", {
      method: "POST",
      body: JSON.stringify({ project: project.id }),
    });
    expect(status.status).toBe(200);
    expect(((await status.json()) as { text: string }).text).toContain("Blinky Board");
    await Bun.write(
      join(project.path, "circuit.netlist.json"),
      JSON.stringify({
        netlist: { components: [], nets: [] },
        board: { widthMm: 40, heightMm: 30 },
      }),
    );
    const queued = await api("/tools/circuit_build", {
      method: "POST",
      body: JSON.stringify({ project: project.id }),
    });
    expect(queued.status).toBe(202);
    const { jobId } = (await queued.json()) as { jobId: string };
    let job: { status: string; result?: { text: string } } = { status: "queued" };
    for (let i = 0; i < 50 && job.status !== "done" && job.status !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      job = (await (await api(`/jobs/${jobId}`)).json()) as typeof job;
    }
    expect(job.status).toBe("done");
    // A fresh runner job cannot hide persisted history, and the activity view is project-scoped.
    daemon.store.jobs.insert({ id: "job_persisted_history", kind: "tool:render_board", projectId: project.id });
    daemon.store.jobs.update("job_persisted_history", { status: "done" });
    const history = await (await api(`/jobs?projectId=${project.id}`)).json() as Array<{ id: string; projectId: string }>;
    expect(history.map(row => row.id)).toContain(jobId);
    expect(history.map(row => row.id)).toContain("job_persisted_history");
    expect(history.every(row => row.projectId === project.id)).toBe(true);
    expect(await (await api("/jobs?projectId=unrelated-project")).json()).toEqual([]);
    expect(await Bun.file(join(project.path, "board.kicad_pcb")).exists()).toBe(true);
    const manifest = (await (await api("/tools/manifest")).json()) as Array<{ name: string }>;
    expect(manifest.length).toBe(daemon.registry.list().length);

    // Route run via HTTP job writes frames and the frames endpoint serves them.
    const rq = await api("/tools/route_run?sync=1", {
      method: "POST",
      body: JSON.stringify({ project: project.id, timeoutMs: 5000 }),
    });
    expect(rq.status).toBe(200);
    const rr = (await rq.json()) as { json: { runId: string } };
    let routeState = "queued";
    for (
      let i = 0;
      i < 100 && !["completed", "failed", "timed_out", "cancelled"].includes(routeState);
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      routeState = ((await (await api(`/route/runs/${rr.json.runId}`)).json()) as { state: string })
        .state;
    }
    expect(routeState).toBe("completed");
    const frames = await api(`/route/runs/${rr.json.runId}/frames?from=2`);
    expect(frames.status).toBe(200);
    const lines = (await frames.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; seq?: number; shapes?: unknown[] });
    expect(lines[0]?.kind).toBe("meta");
    expect(lines.some((line) => line.kind === "static")).toBe(true);
    const filteredFrames = lines.filter((line) => line.kind === "frame");
    expect(filteredFrames.length).toBeGreaterThan(0);
    expect(filteredFrames.every((line) => (line.seq ?? 0) >= 2)).toBe(true);
    expect(filteredFrames.some((line) => (line.shapes?.length ?? 0) > 0)).toBe(true);

    // Legacy runs stored absolute paths. If the projects root moves, prefer the same run beneath
    // the project's current directory instead of returning an empty Cinema stream.
    const movedRunId = "run_moved_project";
    const movedRunDir = join(project.path, ".fabdesk", "runs", movedRunId);
    await mkdir(movedRunDir, { recursive: true });
    await writeFile(
      join(movedRunDir, "frames.jsonl"),
      '{"kind":"meta","runId":"run_moved_project","router":"fab_router","bounds":{"x1":0,"y1":0,"x2":1,"y2":1},"layers":["F.Cu","B.Cu"],"unitsPerMm":1}\n',
    );
    const completedRoute = services.routeRuns.get(rr.json.runId)!;
    services.routeRuns.start({
      ...completedRoute,
      id: movedRunId,
      state: "completed",
      status: "completed",
      framesPath: join(
        home,
        "old-projects-root",
        "blinky-board",
        ".fabdesk",
        "runs",
        movedRunId,
        "frames.jsonl",
      ),
      artifacts: {
        ...completedRoute.artifacts,
        frames: join(".fabdesk", "runs", movedRunId, "frames.jsonl"),
      },
    });
    const movedFrames = await api(`/route/runs/${movedRunId}/frames`);
    expect(movedFrames.status).toBe(200);
    expect(await movedFrames.text()).toContain(`"runId":"${movedRunId}"`);

    // Delete (unregister) keeps the directory; purge removes it.
    expect((await api(`/projects/${project.id}`, { method: "DELETE" })).status).toBe(200);
    expect(await Bun.file(join(project.path, "circuit.netlist.json")).exists()).toBe(true);
    expect((await api(`/projects/${project.id}`)).status).toBe(404);
  });

  test("repository import preserves instructions and leaves board choice to the conversation", async () => {
    const original = daemon.projects.importFromGit.bind(daemon.projects);
    try {
      for (const count of [1, 2]) {
        daemon.projects.importFromGit = options => original({ ...options, clone: async (_url, directory) => {
          await mkdir(join(directory, "hardware"));
          await writeFile(join(directory, "AGENTS.md"), "# Existing engineering instructions\n");
          for (let i = 0; i < count; i++) await writeFile(join(directory, "hardware", `Design-${i}.kicad_pcb`), "(kicad_pcb)");
        } });
        const response = await api("/projects/import-github", { method: "POST", body: JSON.stringify({ url: "https://github.com/example/repository", name: `Import ${count}` }) });
        expect(response.status).toBe(201);
        const body = await response.json() as { project: { path: string }; boards: string[]; adoptedBoard: string | null };
        expect(body.boards).toHaveLength(count); expect(body.adoptedBoard).toBeNull();
        expect(await Bun.file(join(body.project.path, "board.kicad_pcb")).exists()).toBe(false);
        expect(await Bun.file(join(body.project.path, "AGENTS.md")).text()).toBe("# Existing engineering instructions\n");
      }
    } finally { daemon.projects.importFromGit = original; }
  });

  test("threads: create, message → agent run streams agent.* events and persists parts; abort; search", async () => {
    const created = (await (
      await api("/projects", { method: "POST", body: JSON.stringify({ name: "Agent Test" }) })
    ).json()) as { id: string; path: string };
    const repositoryInstructions = "# Engineering policy\nPreserve native source paths and read the project handoff.\n";
    const claudeInstructions = "# Existing Claude instructions\nFollow the repository engineering policy.\n";
    await writeFile(join(created.path, "AGENTS.md"), repositoryInstructions);
    await writeFile(join(created.path, "CLAUDE.md"), claudeInstructions);
    const thread = (await (
      await api("/threads", {
        method: "POST",
        body: JSON.stringify({ agentId: "claude", projectId: created.id }),
      })
    ).json()) as { id: string; title: string };
    expect(thread.title).toBe("New chat");

    const sse = await fetch(`${daemon.url}/events?token=${daemon.token}&topics=agent.*`);
    const reader = sse.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";

    const sent = await api(`/threads/${thread.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "Design a blinky board please" }),
    });
    expect(sent.status).toBe(202);
    const { runId } = (await sent.json()) as { runId: string; messageId: string };
    const deadline = Date.now() + 3000;
    while (!buf.includes('\"topic\":\"agent.done\"') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
    }
    reader.cancel();
    for (const t of [
      "agent.started",
      "agent.delta",
      "agent.tool_use",
      "agent.tool_result",
      "agent.usage",
      "agent.done",
    ])
      expect(buf).toContain(`"topic":"${t}"`);
    expect(buf).toContain('"status":"completed"');
    expect(buf).toContain('"sessionId":"sess-42"');

    expect(lastSession!.cwd).toBe(created.path);
    expect(lastSession!.mcp.url).toBe(`${daemon.url}/mcp`);
    expect(lastSession!.mcp.token).not.toBe(daemon.token);
    expect(lastSession!.env).toMatchObject({
      FABDESK_PROJECT_DIR: created.path,
      FABDESK_CORE_URL: daemon.url,
      FABDESK_KICAD_PROJECT: join(created.path, "board.kicad_pro"),
      FABDESK_KICAD_SCHEMATIC: join(created.path, "board.kicad_sch"),
      FABDESK_KICAD_BOARD: join(created.path, "board.kicad_pcb"),
      KICAD_CLI: "/mock/kicad-cli",
      FABDESK_FP_PCB_BRIDGE_URL: "http://127.0.0.1:4020",
    });
    // App-owned information reaches the adapter without replacing repository policy.
    expect(await Bun.file(join(created.path, "AGENTS.md")).text()).toBe(repositoryInstructions);
    expect(await Bun.file(join(created.path, "CLAUDE.md")).text()).toBe(claudeInstructions);
    const agentInstructions = await Bun.file(join(created.path, ".fabdesk", "agent-context.md")).text();
    expect(lastSession!.prompt).toContain(agentInstructions);
    expect(agentInstructions).toContain("Default root KiCad PCB");
    // the board start map is the one place that prescribes a method; it is present because the board toolset is registered
    expect(agentInstructions).toContain("## Start here");
    expect(agentInstructions).toContain("## Other toolsets");
    expect(agentInstructions).toContain("fabdesk://docs/board-workflow");
    expect(agentInstructions.length).toBeLessThan(9000);
    expect(agentInstructions).toContain("board_check");
    expect(agentInstructions).not.toMatch(/~\/pcb|FABDESK_PCB_BIN|\bpcb (run|review|flow|lastmile|edit)\b/);
    const neutral = agentInstructions.replace(/## Start here[\s\S]*?(?=## Other toolsets)/, "");
    expect(neutral).not.toMatch(/workflow|prefer|retry|repeat until|run .* first/i);
    // Neutral discovery must give both authoring paths equal visibility.
    expect(/circuit_build/i.test(agentInstructions)).toBe(
      /schematic_edit/i.test(agentInstructions),
    );

    const msgs = (await (await api(`/threads/${thread.id}/messages`)).json()) as Array<{
      role: string;
      contentMd: string;
      parts: Array<{ type: string }>;
      runId: string | null;
    }>;
    expect(msgs.length).toBe(2);
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[1]!.role).toBe("assistant");
    expect(msgs[1]!.contentMd).toBe("Hello world");
    expect(msgs[1]!.parts.map((p) => p.type)).toEqual(["text", "tool_use", "tool_result", "text"]);
    expect(msgs[1]!.runId).toBe(runId);
    const detail = (await (await api(`/threads/${thread.id}`)).json()) as {
      title: string;
      run: { status: string; agentSessionId: string };
    };
    expect(detail.title).toBe("Design a blinky board please");
    expect(detail.run.status).toBe("completed");
    expect(detail.run.agentSessionId).toBe("sess-42");
    const tracePath = join(created.path, ".fabdesk", "runs", runId, "trace.jsonl");
    expect(await Bun.file(tracePath).exists()).toBe(true);
    // Export finishes asynchronously after agent.done; wait for the artifact, not a fixed delay.
    const dumpPath = join(created.path, ".fabdesk", "runs", runId, "llm-dump.json");
    const dumpDeadline = Date.now() + 3_000;
    while ((!daemon.store.runDumps.get(runId) || !(await Bun.file(dumpPath).exists())) && Date.now() < dumpDeadline)
      await Bun.sleep(10);
    expect(
      await Bun.file(dumpPath).exists(),
    ).toBe(true);
    expect(JSON.parse(daemon.store.runDumps.get(runId)!.dumpJson)).toMatchObject({
      schema: "fabdesk.llm-run-dump/v1",
      runId,
    });
    expect(
      daemon.store.db
        .query<{ log_path: string }, [string]>("SELECT log_path FROM runs WHERE id = ?")
        .get(runId)?.log_path,
    ).toBe(tracePath);
    // The per-run token is revoked after the run.
    expect(
      (
        await fetch(`${daemon.url}/projects`, {
          headers: { authorization: `Bearer ${lastSession!.mcp.token}` },
        })
      ).status,
    ).toBe(401);

    // Second turn resumes the session id.
    await api(`/threads/${thread.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "again" }),
    });
    expect(lastSession!.resume).toBe("sess-42");
    await new Promise((r) => setTimeout(r, 50));

    const found = (await (await api("/threads?q=blinky")).json()) as Array<{ id: string }>;
    expect(found.map((t) => t.id)).toContain(thread.id);
    const hits = (await (await api("/search?q=hello")).json()) as Array<{ snippet: string }>;
    expect(hits.length).toBeGreaterThan(0);
    expect((await api(`/threads/${thread.id}/abort`, { method: "POST" })).status).toBe(200);
    const branch = (await (
      await api("/threads", {
        method: "POST",
        body: JSON.stringify({ agentId: "codex", parentThreadId: thread.id }),
      })
    ).json()) as { parentThreadId: string };
    expect(branch.parentThreadId).toBe(thread.id);
  });

  test("MCP over streamable HTTP: sessions, core tools, load_toolset, project_status, run token binds the project", async () => {
    const created = (await (
      await api("/projects", { method: "POST", body: JSON.stringify({ name: "MCP Project" }) })
    ).json()) as { id: string };
    const connect = async (token: string, query = "") => {
      const client = new Client({ name: "test", version: "0" });
      const transport = new StreamableHTTPClientTransport(new URL(`${daemon.url}/mcp${query}`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      await client.connect(transport);
      return { client, transport };
    };
    const a = await connect(daemon.token);
    const names = (await a.client.listTools()).tools.map((t) => t.name);
    // Core plus the circuit, verify and render toolsets: both schematic authoring paths start listed.
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("request_project_creation");
    expect(names).toEqual(
      expect.arrayContaining([
        "capability_call",
        "capability_search",
        "circuit_build",
        "circuit_read_errors",
        "load_toolset",
        "project_status",
        "schematic_edit",
        "pcb_update_from_schematic",
        "pcb_resize_outline",
        "verify_erc",
        "release_build",
        "render_view",
        "render_pcb_readiness",
        "render_product_video",
      ]),
    );
    expect(daemon.mcp.activeCount()).toBe(1);

    // Without a project selector the tool asks for one; with it, it works.
    const noProject = await a.client.callTool({ name: "project_status", arguments: {} });
    expect(noProject.isError).toBe(true);
    const withProject = await a.client.callTool({
      name: "project_status",
      arguments: { project: "MCP Project" },
    });
    expect(withProject.isError).toBeFalsy();
    expect((withProject.structuredContent as { id: string }).id).toBe(created.id);

    await a.client.callTool({ name: "load_toolset", arguments: { toolset: "export" } });
    const exportNames = (await a.client.listTools()).tools.map((tool) => tool.name);
    expect(exportNames.length).toBeGreaterThan(names.length);
    expect(exportNames).toEqual(expect.arrayContaining(names));
    expect(exportNames).toEqual(
      expect.arrayContaining(["silk_art", "export_stencil", "export_laser_stencil"]),
    );

    // A second session starts with only the default toolsets (state is per session).
    const b = await connect(daemon.token);
    const secondSessionNames = (await b.client.listTools()).tools.map((tool) => tool.name);
    expect(secondSessionNames.sort()).toEqual([...names].sort());
    expect(secondSessionNames).not.toContain("export_stencil");
    expect(daemon.mcp.activeCount()).toBe(2);

    // Clients that cannot process tools/list_changed can request the complete
    // inventory when the MCP session is initialized.
    const all = await connect(daemon.token, "?toolsets=all");
    expect((await all.client.listTools()).tools.length).toBeGreaterThan(14);

    const native = await connect(daemon.token, "?profile=native");
    const nativeNames = (await native.client.listTools()).tools.map((tool) => tool.name);
    expect(nativeNames).toHaveLength(21);
    expect(nativeNames).toContain("circuit_describe_part");
    expect(nativeNames).toContain("pcb_inspect");
    expect(nativeNames).toContain("schematic_review");
    // Clients that snapshot the list see both authoring paths as directly callable tools.
    expect(nativeNames).toContain("schematic_edit");
    expect(nativeNames).toContain("circuit_build");
    expect(nativeNames).toContain("circuit_read_errors");
    expect(nativeNames).not.toContain("load_toolset");
    expect(nativeNames).not.toContain("native_edit_transaction");

    const planning = await connect(daemon.token, "?profile=planning");
    expect((await planning.client.listTools()).tools.map(tool => tool.name)).toEqual(["request_project_creation"]);

    const substrate = await connect(daemon.token, "?profile=substrate");
    expect((await substrate.client.listTools()).tools).toEqual([]);

    // MCP Apps views: `?apps=on` (stdio proxy started with --apps) lists them for any client;
    // the agent profiles never get them. The plain sessions above did not advertise MCP Apps.
    const apps = await connect(daemon.token, "?apps=on");
    const appNames = (await apps.client.listTools()).tools.map((tool) => tool.name);
    expect(appNames).toContain("board_viewer");
    expect(appNames).toContain("shopping_list_viewer");
    const nativeApps = await connect(daemon.token, "?profile=native&apps=on");
    expect((await nativeApps.client.listTools()).tools.map((tool) => tool.name)).not.toContain(
      "board_viewer",
    );

    // A per-run token pins the default project.
    const runToken = daemon.tokens.mintRunToken({
      runId: "run_x",
      projectId: created.id,
      threadId: "t",
    });
    const c = await connect(runToken);
    const pinned = await c.client.callTool({ name: "project_status", arguments: {} });
    expect(pinned.isError).toBeFalsy();
    expect((pinned.structuredContent as { id: string }).id).toBe(created.id);

    // Unauthenticated MCP is rejected; wrong Host is rejected by DNS-rebinding protection.
    expect((await fetch(`${daemon.url}/mcp`, { method: "POST", body: "{}" })).status).toBe(401);
    const rebinding = await fetch(`${daemon.url}/mcp`, {
      method: "POST",
      headers: {
        ...H(),
        host: "evil.example:80",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "x", version: "0" },
        },
      }),
    });
    expect(rebinding.status).toBe(403);

    await a.transport.terminateSession();
    await all.transport.terminateSession();
    await native.transport.terminateSession();
    await planning.transport.terminateSession();
    await apps.transport.terminateSession();
    await nativeApps.transport.terminateSession();
    await apps.client.close();
    await nativeApps.client.close();
    await a.client.close();
    await b.client.close();
    await all.client.close();
    await native.client.close();
    await planning.client.close();
    await substrate.client.close();
    await c.client.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(daemon.mcp.activeCount()).toBe(3);
  });

  test("ordering rejects export-only projects and a deleted or changed verified board (#116)", async () => {
    const created = await (await api("/projects", { method: "POST", body: JSON.stringify({ name: "Order source evidence" }) })).json() as { id: string; path: string };
    await Bun.write(join(created.path, "exports/fabrication.zip"), "synthetic export");
    await Bun.write(join(created.path, "circuit.routed.json"), "{}");
    const board = "(kicad_pcb)\n";
    const cleanReport = { projectDependencies: await snapshotProjectDependencies(created.path), violations: [], unconnected: [], schematicParity: [], counts: { errors: 0, warnings: 0, unconnected: 0 }, raw: {}, pcbRevision: { sha256: new Bun.CryptoHasher("sha256").update(board).digest("hex") } };
    const order = `/projects/${created.id}/order`;
    const assertBlocked = async () => {
      expect(await (await api(order)).json()).toMatchObject({ ready: false });
      expect((await api(order, { method: "POST", body: JSON.stringify({ vendor: "jlcpcb" }) })).status).toBe(412);
    };
    // Neither old failing evidence nor an orphaned passing report proves export readiness.
    await Bun.write(join(created.path, "reports/drc.json"), JSON.stringify({ ...cleanReport, counts: { errors: 25, warnings: 0, unconnected: 0 } }));
    await assertBlocked();
    await Bun.write(join(created.path, "reports/drc.json"), JSON.stringify(cleanReport));
    await assertBlocked();
    await Bun.write(join(created.path, "board.kicad_pcb"), board);
    expect(await (await api(order)).json()).toMatchObject({ ready: true });
    await Bun.write(join(created.path, "board.kicad_dru"), "new stricter rules");
    await assertBlocked();
    await unlink(join(created.path, "board.kicad_dru"));
    expect(await (await api(order)).json()).toMatchObject({ ready: true });
    await Bun.write(join(created.path, "board.kicad_pcb"), "(kicad_pcb (changed))\n");
    await assertBlocked();
    await unlink(join(created.path, "board.kicad_pcb"));
    await assertBlocked();
  });

  test("opensource catalog, remix, and order readiness", async () => {
    const catalog = (await (await api("/opensource?q=koyomi")).json()) as {
      projects: Array<{ id: string; cloneUrl: string }>;
    };
    expect(catalog.projects.some((p) => p.id === "tensorfleet/koyomi-lvds-hat")).toBe(true);
    const one = await api("/opensource/projects/tensorfleet/koyomi-lvds-hat");
    expect(one.status).toBe(200);
    expect(((await one.json()) as { name: string }).name).toBe("Koyomi LVDS HAT");

    const created = (await (
      await api("/projects", { method: "POST", body: JSON.stringify({ name: "Order Board" }) })
    ).json()) as { id: string; path: string };
    const notReady = await api(`/projects/${created.id}/order`);
    expect(notReady.status).toBe(200);
    expect(((await notReady.json()) as { ready: boolean }).ready).toBe(false);
    await Bun.write(`${created.path}/board.kicad_pcb`, "(kicad_pcb)\n");
    const blocked = (await (await api(`/projects/${created.id}/order`)).json()) as {
      ready: boolean;
      checks: { drc: string };
    };
    expect(blocked).toMatchObject({ ready: false, checks: { drc: "missing" } });
    const blockedPost = await api(`/projects/${created.id}/order`, {
      method: "POST",
      body: JSON.stringify({ vendor: "jlcpcb" }),
    });
    expect(blockedPost.status).toBe(412);
    const pcbSha = new Bun.CryptoHasher("sha256").update("(kicad_pcb)\n").digest("hex");
    await Bun.write(
      `${created.path}/reports/drc.json`,
      JSON.stringify({
        violations: [],
        unconnected: [],
        schematicParity: [],
        counts: { errors: 0, warnings: 0, unconnected: 0 },
        raw: {},
        pcbRevision: { sha256: pcbSha },
        projectDependencies: await snapshotProjectDependencies(created.path),
      }),
    );
    const ready = (await (await api(`/projects/${created.id}/order`)).json()) as { ready: boolean };
    expect(ready.ready).toBe(true);
    const laser = await api(`/projects/${created.id}/order`, {
      method: "POST",
      body: JSON.stringify({ vendor: "laser" }),
    });
    expect(laser.status).toBe(400);
    const jlc = await api(`/projects/${created.id}/order`, {
      method: "POST",
      body: JSON.stringify({ vendor: "jlcpcb" }),
    });
    expect(jlc.status).toBe(200);
    expect(((await jlc.json()) as { enabled: boolean; orderUrl: string }).orderUrl).toContain(
      "jlcpcb.com",
    );

    expect(
      (await fetch(`${daemon.url}/opensource/preview/tensorfleet/koyomi-lvds-hat`)).status,
    ).toBe(401);
    expect(
      (await fetch(`${daemon.url}/opensource/preview/nope/nope?token=${daemon.token}`)).status,
    ).toBe(404);
    const preview = await fetch(
      `${daemon.url}/opensource/preview/tensorfleet/koyomi-lvds-hat?token=${daemon.token}`,
    );
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type") ?? "").toMatch(/^image\//);
    expect(preview.headers.get("cache-control")).toBe("private, max-age=3600");
    expect((await preview.arrayBuffer()).byteLength).toBeGreaterThan(64);
  });

  test("PATCH /threads/:id persists pin and lists pinned first", async () => {
    const older = (await (
      await api("/threads", {
        method: "POST",
        body: JSON.stringify({ agentId: "claude", title: "Older chat" }),
      })
    ).json()) as { id: string; pinned: boolean };
    const newer = (await (
      await api("/threads", {
        method: "POST",
        body: JSON.stringify({ agentId: "claude", title: "Newer chat" }),
      })
    ).json()) as { id: string; pinned: boolean };
    expect(older.pinned).toBe(false);
    expect(newer.pinned).toBe(false);
    const pinned = (await (
      await api(`/threads/${older.id}`, { method: "PATCH", body: JSON.stringify({ pinned: true }) })
    ).json()) as { id: string; pinned: boolean };
    expect(pinned.pinned).toBe(true);
    const listed = (await (await api("/threads")).json()) as Array<{ id: string; pinned: boolean }>;
    const ids = listed.map((t) => t.id);
    expect(ids.indexOf(older.id)).toBeLessThan(ids.indexOf(newer.id));
    expect(listed.find((t) => t.id === older.id)?.pinned).toBe(true);
    const unpinned = (await (
      await api(`/threads/${older.id}`, {
        method: "PATCH",
        body: JSON.stringify({ pinned: false }),
      })
    ).json()) as { pinned: boolean };
    expect(unpinned.pinned).toBe(false);
    const after = (await (await api(`/threads/${older.id}`)).json()) as { pinned: boolean };
    expect(after.pinned).toBe(false);
  });

  test("board comments and NOTES.md are git-native project files", async () => {
    const project = (await (
      await api("/projects", { method: "POST", body: JSON.stringify({ name: "Comment Board" }) })
    ).json()) as { id: string; path: string };
    const empty = await api(`/projects/${project.id}/comments`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({
      contract: { name: "fabplane.board-comments", version: "1.0.0" },
      comments: [],
    });
    const created = await api(`/projects/${project.id}/comments`, {
      method: "POST",
      body: JSON.stringify({
        question: "What does this chip do here?",
        anchor: { view: "pcb", x: 12, y: 8, ref: "U12" },
        author: "maya",
      }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { comment: { id: string }; label: string };
    expect(body.label).toBe("U12");
    const answered = await api(`/projects/${project.id}/comments/${body.comment.id}`, {
      method: "PATCH",
      body: JSON.stringify({ answer: "U12 is the MCU." }),
    });
    expect(answered.status).toBe(200);
    expect(((await answered.json()) as { comment: { status: string } }).comment.status).toBe(
      "answered",
    );
    expect(
      (
        await api(`/projects/${project.id}/notes`, {
          method: "PUT",
          body: JSON.stringify({ content: "Shared notes.\n" }),
        })
      ).status,
    ).toBe(200);
    expect(((await (await api(`/projects/${project.id}/notes`)).json()) as { content: string }).content).toBe(
      "Shared notes.\n",
    );
    expect(await Bun.file(join(project.path, "comments.json")).exists()).toBe(true);
    expect(await Bun.file(join(project.path, "NOTES.md")).text()).toBe("Shared notes.\n");
  });

  test("GET /routers lists bundled fab_router and install-on-demand TraceMaker", async () => {
    const res = await api("/routers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      routers: Array<{ id: string; state: string; ready: boolean }>;
    };
    const ids = body.routers.map((row) => row.id);
    expect(ids).toContain("fab_router");
    expect(ids).toContain("freerouting");
    expect(ids).toContain("tracemaker");
    expect(body.routers.find((row) => row.id === "fab_router")).toMatchObject({
      state: "bundled",
      ready: true,
    });
    expect(body.routers.find((row) => row.id === "tracemaker")?.state).toBe("not_installed");
  });

  test("uninstalling the router that is the saved default resets the default to automatic", async () => {
    const set = await api("/settings", {
      method: "PATCH",
      body: JSON.stringify({ preferredRouter: "tracemaker" }),
    });
    expect(((await set.json()) as { preferredRouter?: string }).preferredRouter).toBe("tracemaker");
    const gone = await api("/routers/tracemaker", { method: "DELETE" });
    expect(gone.status).toBe(200);
    const after = (await (await api("/settings")).json()) as { preferredRouter?: string | null };
    expect(after.preferredRouter ?? null).toBeNull();
    const list = (await (await api("/routers")).json()) as { preferredRouter?: string };
    expect(list.preferredRouter).toBeUndefined();

    // uninstalling some other router leaves the default alone
    await api("/settings", {
      method: "PATCH",
      body: JSON.stringify({ preferredRouter: "fab_router" }),
    });
    await api("/routers/tracemaker", { method: "DELETE" });
    const kept = (await (await api("/settings")).json()) as { preferredRouter?: string | null };
    expect(kept.preferredRouter).toBe("fab_router");
    await api("/settings", { method: "PATCH", body: JSON.stringify({ preferredRouter: null }) });
  });
});

 test("idea drafts save references, reject engineering writes, and promote without replacing conversation ownership", async () => {
  const created = await api("/projects", { method: "POST", body: JSON.stringify({ name: "HTTP idea draft", draft: true }) });
  expect(created.status).toBe(201);
  const draft = await created.json() as { id: string; path: string; isDraft: boolean };
  expect(draft.isDraft).toBe(true);
  const write = await api(`/projects/${draft.id}/files/board.kicad_pcb`, { method: "PUT", body: "forbidden board" });
  expect(write.status).toBe(412);
  const unsafePatch = await api(`/projects/${draft.id}`, { method: "PATCH", body: JSON.stringify({ manifest: { ideaDraft: null } }) });
  expect(unsafePatch.status).toBe(400);
  const read = await api(`/projects/${draft.id}/files/fabdesk.json`);
  expect(read.status).toBe(200);
  const t = await (await api("/threads", { method: "POST", body: JSON.stringify({ projectId: draft.id, agentId: "claude" }) })).json() as { id: string };
  daemon.store.threads.addMessage({ threadId: t.id, role: "user", contentMd: "Keep my planning conversation" });
  const token = daemon.tokens.mintRunToken({ runId: "idea-security-test", projectId: draft.id, threadId: t.id });
  const agentPromote = await api(`/projects/${draft.id}/promote`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "Not user approved" }) });
  expect(agentPromote.status).toBe(403);
  const agentNew = await api("/projects", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "Bypass draft" }) });
  expect(agentNew.status).toBe(403);
  daemon.tokens.revoke(token);
  const promotion = await api(`/projects/${draft.id}/promote`, { method: "POST", body: JSON.stringify({ name: "HTTP promoted idea" }) });
  expect(promotion.status).toBe(200);
  const promoted = await promotion.json() as { id: string; manifest: Record<string, unknown> };
  expect(promoted.id).toBe(draft.id);
  expect(promoted.manifest.ideaDraft).toBeUndefined();
  expect(daemon.store.threads.get(t.id)?.projectId).toBe(draft.id);
  expect(daemon.store.threads.messages(t.id)[0]?.contentMd).toBe("Keep my planning conversation");
  const retry = await api(`/projects/${draft.id}/promote`, { method: "POST", body: JSON.stringify({ name: "Duplicate" }) });
  expect(retry.status).toBe(412);
});


test("working design previews render without a UI bridge, reject stale requests and remain scoped to their chat", async () => {
  const project = await (await api("/projects", { method: "POST", body: JSON.stringify({ name: "native-context" }) })).json();
  const handle = (await daemon.projects.handle(project.id))!;
  const thread = daemon.store.threads.create({ agentId: "claude", projectId: project.id });
  const other = daemon.store.threads.create({ agentId: "claude" });
  await mkdir(join(handle.dir, "hardware"));
  const sourcePath = "hardware/native-v7.kicad_pcb";
  await writeFile(join(handle.dir, sourcePath), '(kicad_pcb (version 20250114) (generator "native") (gr_rect (start 0 0) (end 20 20) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts")))');
  const selected = await new WorkingDesigns(daemon.config.home).select(handle, sourcePath, thread.id);
  const endpoint = `/projects/${project.id}/working-design`;
  expect(await (await api(endpoint)).json()).toEqual({ sourcePath: null });
  expect((await api(`${endpoint}?threadId=${other.id}`)).status).toBe(404);
  const design = await (await api(`${endpoint}?threadId=${thread.id}`)).json();
  expect(design).toMatchObject({ sourcePath });
  const request = { threadId: thread.id, kind: "pcb", sourceRevision: design.sourceRevision };
  const result = await api(`${endpoint}/render`, { method: "POST", body: JSON.stringify(request) });
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ sourcePath, sourceRevision: design.sourceRevision, sourceBinding: { status: "current" } });
  const exportGlb = services.kicad.exportGlb;
  try {
    services.kicad.exportGlb = async (_cli, { output }) => { await writeFile(output, "mock GLB"); return { fused: false, warnings: [] }; };
    const model = await api(`${endpoint}/render`, { method: "POST", body: JSON.stringify({ ...request, kind: "3d" }) });
    expect(model.status).toBe(200);
    expect(await model.json()).toMatchObject({ path: "renders/board.glb", sourcePath, sourceRevision: design.sourceRevision });
  } finally { services.kicad.exportGlb = exportGlb; }
  await writeFile(join(handle.dir, sourcePath), '(kicad_pcb (version 20250114) (generator "new") (gr_rect (start 0 0) (end 20 20) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts")))');
  expect((await api(`${endpoint}/render`, { method: "POST", body: JSON.stringify(request) })).status).toBe(409);
  const renderPcb = services.kicad.exportPcbSvg;
  try {
    services.kicad.exportPcbSvg = async (...args) => { const result = await renderPcb(...args); await writeFile(join(handle.dir, sourcePath), '(kicad_pcb (version 20250114) (generator "raced"))'); return result; };
    const next = await (await api(`${endpoint}?threadId=${thread.id}`)).json();
    expect((await api(`${endpoint}/render`, { method: "POST", body: JSON.stringify({ ...request, sourceRevision: next.sourceRevision }) })).status).toBe(412);
  } finally { services.kicad.exportPcbSvg = renderPcb; }
});

test("native source namespace uses original filenames, isolates generated content and refuses stale clients", async () => {
  const project = await (await api("/projects", { method: "POST", body: JSON.stringify({ name: "native-originals" }) })).json();
  const handle = (await daemon.projects.handle(project.id))!;
  const thread = daemon.store.threads.create({ agentId: "claude", projectId: project.id });
  const designs = new WorkingDesigns(daemon.config.home);
  await mkdir(join(handle.dir, "hardware/renders"), { recursive: true });
  const pcb = (name: string) => `(kicad_pcb (version 20250114) (generator "${name}"))`;
  await writeFile(join(handle.dir, "board.kicad_pcb"), "root sentinel");
  await writeFile(join(handle.dir, "hardware/rev-a.kicad_pcb"), pcb("a"));
  await writeFile(join(handle.dir, "hardware/rev-b.kicad_pcb"), pcb("b"));
  await writeFile(join(handle.dir, "hardware/renders/pcb.svg"), "repository render sentinel");
  const namespace = (name: string) => `/native-context/${encodeURIComponent(JSON.stringify({ projectId: project.id, threadId: thread.id, sourcePath: `hardware/rev-${name}.kicad_pcb` }))}`;
  await designs.select(handle, "hardware/rev-a.kicad_pcb", thread.id, 1);
  const root = `${namespace("a")}/projects/${project.id}`;
  expect(await (await api(`${root}/files/board.kicad_pcb`)).text()).toBe(pcb("a"));
  const detail = await (await api(root)).json();
  expect(detail.files.some((file: {path: string}) => file.path === "board.kicad_pcb")).toBe(true);
  const sources = await (await api(`${root}/board-sources`)).json();
  expect(sources.sources[0].status).toBe("available");
  expect((await api(`${root}/files/renders/pcb.svg`)).status).toBe(404);
  expect((await api(`${root}/files/renders/pcb.svg`, { method: "PUT", body: "a cache" })).status).toBe(200);
  expect((await api(`${root}/files/board.kicad_pcb`, { method: "PUT", body: pcb("edited-a") })).status).toBe(200);
  expect(await readFile(join(handle.dir, "hardware/rev-a.kicad_pcb"), "utf8")).toBe(pcb("edited-a"));
  expect(await readFile(join(handle.dir, "hardware/rev-b.kicad_pcb"), "utf8")).toBe(pcb("b"));
  expect(await readFile(join(handle.dir, "hardware/renders/pcb.svg"), "utf8")).toBe("repository render sentinel");
  await designs.select(handle, "hardware/rev-b.kicad_pcb", thread.id, 2);
  expect((await api(`${root}/files/board.kicad_pcb`, { method: "PUT", body: "stale" })).status).toBe(412);
  const other = `${namespace("b")}/projects/${project.id}`;
  expect((await api(`${other}/files/renders/pcb.svg`)).status).toBe(404);
  expect((await api(`${other}/files/renders/pcb.svg`, { method: "PUT", body: "b cache" })).status).toBe(200);
  await designs.select(handle, "hardware/rev-a.kicad_pcb", thread.id, 3);
  expect(await (await api(`${root}/files/renders/pcb.svg`)).text()).toBe("a cache");
  expect(await readFile(join(handle.dir, "board.kicad_pcb"), "utf8")).toBe("root sentinel");
  expect(await Bun.file(join(handle.dir, "hardware/board.kicad_pcb")).exists()).toBe(false);
});

test("canvas pin → agent answer → reopen uses one native store, isolated across sibling basenames", async () => {
  const project = await (await api("/projects", { method: "POST", body: JSON.stringify({ name: "native-pins" }) })).json();
  const handle = (await daemon.projects.handle(project.id))!;
  const thread = daemon.store.threads.create({ agentId: "claude", projectId: project.id });
  const designs = new WorkingDesigns(daemon.config.home);
  await mkdir(join(handle.dir, "hardware"));
  for (const name of ["io", "carrier"]) await writeFile(join(handle.dir, `hardware/${name}.kicad_pcb`), `(kicad_pcb (version 20250114) (generator "${name}"))`);
  const namespace = (name: string) => `/native-context/${encodeURIComponent(JSON.stringify({ projectId: project.id, threadId: thread.id, sourcePath: `hardware/${name}.kicad_pcb` }))}`;
  await designs.select(handle, "hardware/io.kicad_pcb", thread.id, 1);
  const pins = `${namespace("io")}/projects/${project.id}/comments`;
  const created = await api(pins, { method: "POST", body: JSON.stringify({ question: "Check U1", anchor: { view: "pcb", ref: "U1" } }) });
  expect(created.status).toBe(201);
  const { comment } = await created.json();
  const token = daemon.tokens.mintRunToken({ runId: "native-pin-answer", projectId: project.id, threadId: thread.id });
  const answer = await api("/tools/comment_answer", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ id: comment.id, answer: "Verified this pin" }) });
  expect(answer.status).toBe(200);
  expect((await (await api(pins)).json()).comments[0]).toMatchObject({ id: comment.id, answer: "Verified this pin", status: "answered" });
  expect((await (await api(`/projects/${project.id}/comments`)).json()).comments).toEqual([]);
  await designs.select(handle, "hardware/carrier.kicad_pcb", thread.id, 2);
  expect((await (await api(`${namespace("carrier")}/projects/${project.id}/comments`)).json()).comments).toEqual([]);
  expect((await api(pins)).status).toBe(412);
  await designs.select(handle, "hardware/io.kicad_pcb", thread.id, 3);
  expect((await (await api(pins)).json()).comments[0].answer).toBe("Verified this pin");
});

test("native manufacturing exports use selected PCB bytes with and without a root sentinel", async () => {
  const original = services.kicad.exportGerbers;
  const observed: string[] = [];
  services.kicad.exportGerbers = async (_cli, { board, outDir }) => {
    const bytes = await readFile(board, "utf8"); observed.push(bytes);
    const path = join(outDir, "selected.gtl"); await writeFile(path, bytes);
    return { paths: [path] };
  };
  try {
    for (const rootPresent of [true, false]) {
      const project = await (await api("/projects", { method: "POST", body: JSON.stringify({ name: `native-export-${rootPresent}` }) })).json();
      const handle = (await daemon.projects.handle(project.id))!;
      const thread = daemon.store.threads.create({ agentId: "claude", projectId: project.id });
      const designs = new WorkingDesigns(daemon.config.home);
      await mkdir(join(handle.dir, "hardware"));
      const source = '(kicad_pcb (version 20250114) (generator "selected-io-v3"))';
      await writeFile(join(handle.dir, "hardware/io-v3.kicad_pcb"), source);
      if (rootPresent) await writeFile(join(handle.dir, "board.kicad_pcb"), "ROOT SENTINEL");
      await designs.select(handle, "hardware/io-v3.kicad_pcb", thread.id, 1);
      const namespace = `/native-context/${encodeURIComponent(JSON.stringify({ projectId: project.id, threadId: thread.id, sourcePath: "hardware/io-v3.kicad_pcb" }))}`;
      const response = await api(`${namespace}/tools/export_gerbers?sync=1`, { method: "POST", body: JSON.stringify({ project: project.id }) });
      expect(response.status).toBe(200);
      expect((await response.json()).isError).not.toBe(true);
      expect(await (await api(`${namespace}/projects/${project.id}/files/exports/gerbers/selected.gtl`)).text()).toBe(source);
      expect(observed.at(-1)).toBe(source);
      if (rootPresent) expect(await readFile(join(handle.dir, "board.kicad_pcb"), "utf8")).toBe("ROOT SENTINEL");
      else expect(await Bun.file(join(handle.dir, "board.kicad_pcb")).exists()).toBe(false);
    }
  } finally { services.kicad.exportGerbers = original; }
});
