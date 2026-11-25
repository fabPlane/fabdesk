/**
 * End-to-end proof: fabdesk-core serve() POSTs the onboarding funnel to a live
 * mock PostHog `/capture/` HTTP server (no funnelFetch stub). First-touch comes
 * from a fabplane://open URL as `/try` builds it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_PRINCIPAL } from "@fabdesk/auth-client";
import { FUNNEL_EVENTS, type FunnelSnapshot } from "@fabdesk/protocol";
import type { CoreServices } from "@fabdesk/tools";
import { Store } from "../src/db";
import { serve, type Daemon } from "../src/serve";
import { mockServices } from "../../../packages/tools/test/mock-services";

const PRE_ANON = "anon_pre_try_install";
const PH_ID = "ph_try_landing";
const OPEN_URL =
  "fabplane://open?ph_id=ph_try_landing&utm_source=google&utm_medium=cpc&utm_campaign=try&utm_content=hero&utm_term=pcb&gclid=CjwTEST&referrer=https://news.example/path";

type CaptureBody = {
  api_key?: string;
  event?: string;
  properties?: Record<string, unknown>;
  timestamp?: string;
};

const captures: CaptureBody[] = [];
const capturePaths: string[] = [];

const posthog = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && (url.pathname === "/capture/" || url.pathname === "/capture")) {
      capturePaths.push(url.pathname);
      captures.push((await request.json()) as CaptureBody);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  },
});

let daemon: Daemon;

const wait = () => new Promise((resolve) => setTimeout(resolve, 50));

function named(event: string): CaptureBody[] {
  return captures.filter((b) => b.event === event);
}

function props(body: CaptureBody | undefined): Record<string, unknown> {
  return (body?.properties ?? {}) as Record<string, unknown>;
}

const H = () => ({ authorization: `Bearer ${daemon.token}` });
const api = (path: string, init: RequestInit = {}) =>
  fetch(`${daemon.url}${path}`, {
    ...init,
    headers: { ...H(), "content-type": "application/json", ...(init.headers ?? {}) },
  });

async function snapshot(): Promise<FunnelSnapshot> {
  const res = await api("/funnel");
  expect(res.status).toBe(200);
  return (await res.json()) as FunnelSnapshot;
}

function emitTool(id: string, name: string, result: { output: unknown; isError?: boolean }): void {
  daemon.bus.emit({
    ts: Date.now(),
    topic: "agent.tool_use",
    runId: `run-${id}`,
    messageId: `msg-${id}`,
    id,
    name,
    input: {},
  });
  daemon.bus.emit({
    ts: Date.now(),
    topic: "agent.tool_result",
    runId: `run-${id}`,
    messageId: `msg-${id}`,
    id,
    output: result.output,
    ...(result.isError ? { isError: true } : {}),
  });
}

beforeAll(async () => {
  const home = await mkdtemp(join(tmpdir(), "fabdesk-funnel-e2e-"));
  const seed = Store.open(join(home, "fabdesk.db"));
  seed.settings.writeRaw("funnel_anon_distinct_id", PRE_ANON);
  seed.close();
  process.env["FABDESK_PROJECTS_DIR"] = join(home, "Fabdesk");
  process.env["FABDESK_TOKEN"] = "funnel-e2e-token-0123456789abcdef";
  process.env["FABDESK_CHANNEL"] = "internal";
  process.env["FABDESK_RUNTIME_ID"] = "runtime-funnel-e2e";
  daemon = await serve({
    port: 0,
    dataDir: home,
    handshakeFile: join(home, "daemon.json"),
    localAuth: true,
    parentPid: process.pid,
    quiet: true,
    watchProjects: false,
    funnelEnv: {
      POSTHOG_KEY: "phc_e2e_proof",
      POSTHOG_HOST: posthog.url.origin,
    },
    funnelArgv: ["fabdesk-core", "serve", OPEN_URL],
    services: async ({ projects, bus, store }) =>
      mockServices([], {
        projects,
        bus: { emit: (e) => bus.emit(e) },
        routeRuns: store.routeRuns,
        channel: "internal",
      }) as unknown as CoreServices,
  });
  await daemon.funnel.flush();
});

afterAll(async () => {
  await daemon.close("tests done");
  posthog.stop(true);
});

describe("funnel e2e PostHog /capture/ proof", () => {
  test("fabplane://open first-touch aliases, identifies with $set_once, and captures launch", async () => {
    expect(capturePaths.every((p) => p === "/capture/" || p === "/capture")).toBe(true);
    expect(captures.every((b) => b.api_key === "phc_e2e_proof")).toBe(true);
    const alias = named("$create_alias")[0];
    expect(alias).toBeDefined();
    expect(props(alias)["distinct_id"]).toBe(PRE_ANON);
    expect(props(alias)["alias"]).toBe(PH_ID);
    const identify = named("$identify")[0];
    expect(identify).toBeDefined();
    expect(props(identify)["distinct_id"]).toBe(LOCAL_PRINCIPAL.subject);
    expect(props(identify)["$anon_distinct_id"]).toBe(PH_ID);
    expect(props(identify)["$set_once"]).toEqual({
      utm_source: "google",
      utm_medium: "cpc",
      utm_campaign: "try",
      utm_content: "hero",
      utm_term: "pcb",
      gclid: "CjwTEST",
      referrer: "https://news.example/path",
    });
    const snap = await snapshot();
    expect(snap.captureEnabled).toBe(true);
    expect(snap.optedIn).toBe(true);
    expect(snap.handoff).toMatchObject({
      phId: PH_ID,
      utmSource: "google",
      utmCampaign: "try",
      gclid: "CjwTEST",
    });
    expect(snap.identifiedSubject).toBe(LOCAL_PRINCIPAL.subject);
    expect(snap.events.some((e) => e.event === "onboarding_app_launched")).toBe(true);
    expect(snap.events.some((e) => e.event === "onboarding_landing")).toBe(true);
    expect(snap.events.some((e) => e.event === "onboarding_signed_in")).toBe(true);
    expect(named("onboarding_app_launched")).toHaveLength(1);
    expect(named("onboarding_landing")).toHaveLength(1);
    expect(named("onboarding_signed_in")).toHaveLength(1);
  });

  test("each remaining onboarding_* step reaches /capture/; failed builds do not", async () => {
    const login = await api("/v1/auth/login", { method: "POST", body: "{}" });
    expect(login.status).toBe(200);
    const created = await api("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Try Board" }),
    });
    expect(created.status).toBe(201);
    daemon.bus.emit({
      ts: Date.now(),
      topic: "agent.started",
      runId: "run-ai",
      threadId: "thread-ai",
      agentId: "claude",
    });
    const review = await api("/funnel/events", {
      method: "POST",
      body: JSON.stringify({ event: "onboarding_first_review_viewed", properties: { source: "review" } }),
    });
    expect(review.status).toBe(200);
    expect((await review.json()) as { recorded: boolean }).toEqual({ recorded: true });
    const board = await api("/funnel/events", {
      method: "POST",
      body: JSON.stringify({ event: "onboarding_first_board_viewed", properties: { source: "pcb" } }),
    });
    expect(board.status).toBe(200);
    expect((await board.json()) as { recorded: boolean }).toEqual({ recorded: true });
    emitTool("build-fail", "circuit_build", { output: { error: "layout failed" }, isError: true });
    await wait();
    await daemon.funnel.flush();
    const afterFail = await snapshot();
    expect(afterFail.events.some((e) => e.event === "onboarding_first_board_built")).toBe(false);
    expect(named("onboarding_first_board_built")).toHaveLength(0);
    emitTool("build-ok", "circuit_build", { output: { ok: true } });
    emitTool("route-ok", "route_run", { output: { ok: true } });
    emitTool("import-ok", "project_import_kicad", { output: { ok: true } });
    await wait();
    await daemon.funnel.flush();
    const snap = await snapshot();
    for (const event of FUNNEL_EVENTS) {
      expect(snap.events.some((e) => e.event === event)).toBe(true);
      expect(named(event).length).toBeGreaterThan(0);
    }
    expect(named("onboarding_first_board_built")).toHaveLength(1);
    expect(props(named("onboarding_first_review_viewed")[0])["source"]).toBe("review");
    expect(props(named("onboarding_first_board_viewed")[0])["source"]).toBe("pcb");
  });

  test("sign-out resets identity; opt-out silences further /capture/ posts", async () => {
    const before = await snapshot();
    expect(before.identifiedSubject).toBe(LOCAL_PRINCIPAL.subject);
    daemon.bus.emit({
      ts: Date.now(),
      topic: "auth.state",
      state: { mode: "fabplane", status: "signed_out" },
    });
    await wait();
    const signedOut = await snapshot();
    expect(signedOut.identifiedSubject).toBeNull();
    expect(signedOut.distinctId.startsWith("anon_")).toBe(true);
    expect(signedOut.distinctId).not.toBe(PRE_ANON);
    expect(signedOut.distinctId).not.toBe(PH_ID);
    expect(signedOut.distinctId).not.toBe(LOCAL_PRINCIPAL.subject);
    expect(signedOut.handoff.phId).toBe(PH_ID);
    const patched = await api("/settings", {
      method: "PATCH",
      body: JSON.stringify({ productAnalytics: false }),
    });
    expect(patched.status).toBe(200);
    const silentFrom = captures.length;
    await api("/projects", { method: "POST", body: JSON.stringify({ name: "Ignored" }) });
    daemon.bus.emit({
      ts: Date.now(),
      topic: "agent.started",
      runId: "run-silent",
      threadId: "thread-silent",
      agentId: "claude",
    });
    emitTool("silent-build", "circuit_build", { output: { ok: true } });
    await wait();
    await daemon.funnel.flush();
    const after = await snapshot();
    expect(after.optedIn).toBe(false);
    expect(captures.length).toBe(silentFrom);
    expect(after.events.length).toBe(signedOut.events.length);
  });
});
