import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoreServices } from "@fabdesk/tools";
import { mockServices } from "../../../packages/tools/test/mock-services";
import { cloudApiFactory, createCloudService } from "../src/cloud";
import { serve, type Daemon } from "../src/serve";

let daemon: Daemon;
let downstream: ReturnType<typeof Bun.serve>;
let downstreamPort = 0;
let reply = { status: 200, body: JSON.stringify({ visibility: "private" }) };
let calls = 0;
let token: string | null = "synthetic-cloud-token";
let projectId: string;
const savedEnv = { ...process.env };
function startDownstream() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: downstreamPort,
    fetch(request) {
      calls++;
      expect(new URL(request.url).pathname).toBe(`/v1/private/project-shares/${projectId}`);
      expect(request.method).toBe("GET");
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-cloud-token");
      return new Response(reply.body, {
        status: reply.status,
        headers: { "content-type": "application/json" },
      });
    },
  });
}
const request = (path: string) =>
  fetch(`${daemon.url}${path}`, { headers: { authorization: `Bearer ${daemon.token}` } });
const share = () => request(`/projects/${projectId}/share`);

beforeAll(async () => {
  downstream = startDownstream();
  downstreamPort = downstream.port!;
  const home = await mkdtemp(join(tmpdir(), "fabdesk-cloud-transport-"));
  process.env["FABDESK_PROJECTS_DIR"] = join(home, "projects");
  process.env["FABDESK_TOKEN"] = "synthetic-core-token-0123456789abcdef";
  process.env["FABDESK_CHANNEL"] = "internal";
  daemon = await serve({
    port: 0,
    dataDir: home,
    handshakeFile: join(home, "daemon.json"),
    localAuth: true,
    parentPid: process.pid,
    quiet: true,
    watchProjects: false,
    services: async ({ projects, bus, store }) =>
      mockServices([], {
        projects,
        bus: { emit: (event) => bus.emit(event) },
        routeRuns: store.routeRuns,
        channel: "internal",
        settings: () => store.settings.get(),
        cloud: createCloudService({
          apiOrigin: `http://127.0.0.1:${downstreamPort}`,
          token: () => token,
          settings: () => store.settings.get(),
        }),
      }) as unknown as CoreServices,
    doctor: async () => ({
      version: "test",
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
  const created = await fetch(`${daemon.url}/projects`, {
    method: "POST",
    headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "Synthetic sharing transport" }),
  });
  expect(created.status).toBe(201);
  projectId = ((await created.json()) as { id: string }).id;
});
afterAll(async () => {
  downstream?.stop(true);
  await daemon?.close("transport tests done");
  for (const key of ["FABDESK_PROJECTS_DIR", "FABDESK_TOKEN", "FABDESK_CHANNEL"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

test("GET share reports a refused cloud connection as unavailable, then recovers without changing access", async () => {
  expect(await (await share()).json()).toEqual({ visibility: "private" });
  downstream.stop(true);
  try {
    const response = await share();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({
      error: "cloud_unreachable",
      message: "Could not reach fabplane.com. Check your connection and try again.",
    });
    expect(body).not.toHaveProperty("visibility");
    expect(JSON.stringify(body)).not.toContain("synthetic-cloud-token");
  } finally {
    downstream = startDownstream();
  }
  const response = await share();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ visibility: "private" });
});

test("cloud HTTP/auth errors retain their status and code", async () => {
  try {
    for (const [status, code] of [
      [401, "expired_session"],
      [403, "forbidden"],
      [503, "maintenance"],
    ] as const) {
      reply = {
        status,
        body: JSON.stringify({ error: code, message: "Synthetic upstream response" }),
      };
      const response = await share();
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        error: status === 401 ? "cloud_signed_out" : code,
        message: "Synthetic upstream response",
      });
    }
    for (const status of [404, 405, 501]) {
      reply = {
        status,
        body: JSON.stringify({ error: "not_implemented", message: "Unsupported sharing API" }),
      };
      const response = await share();
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: "sharing_unavailable" });
    }
  } finally {
    reply = { status: 200, body: JSON.stringify({ visibility: "private" }) };
  }
});

test("signed-out and missing local project still fail before contacting the cloud", async () => {
  const before = calls;
  token = null;
  try {
    expect((await share()).status).toBe(401);
  } finally {
    token = "synthetic-cloud-token";
  }
  expect((await request("/projects/missing/share")).status).toBe(404);
  expect(calls).toBe(before);
});

test("malformed cloud JSON remains an internal failure, not a connection failure", async () => {
  reply = { status: 200, body: "not JSON" };
  try {
    const response = await share();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "internal" });
  } finally {
    reply = { status: 200, body: JSON.stringify({ visibility: "private" }) };
  }
});

test("invalid request construction remains a TypeError outside the fetch failure boundary", async () => {
  const api = cloudApiFactory({ origin: "http://[invalid", token: "synthetic-cloud-token" });
  const error = await api.getProjectShare!("local").catch((error) => error);
  expect(error).toBeInstanceOf(TypeError);
  expect(error).not.toHaveProperty("status");
});
