import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FunnelSnapshot } from "@fabdesk/protocol";
import type { CoreServices } from "@fabdesk/tools";
import { serve, type Daemon } from "../src/serve";
import { mockServices } from "../../../packages/tools/test/mock-services";

let daemon: Daemon;
let captures: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  const home = await mkdtemp(join(tmpdir(), "fabdesk-funnel-http-"));
  process.env["FABDESK_PROJECTS_DIR"] = join(home, "Fabdesk");
  process.env["FABDESK_TOKEN"] = "funnel-token-0123456789abcdef";
  process.env["FABDESK_CHANNEL"] = "internal";
  process.env["FABDESK_RUNTIME_ID"] = "runtime-funnel-http";
  daemon = await serve({
    port: 0,
    dataDir: home,
    handshakeFile: join(home, "daemon.json"),
    localAuth: true,
    parentPid: process.pid,
    quiet: true,
    watchProjects: false,
    funnelEnv: {
      POSTHOG_KEY: "phc_http",
      POSTHOG_HOST: "https://example.i.posthog.com",
      FABDESK_PH_ID: "ph_from_env",
      FABDESK_UTM_SOURCE: "newsletter",
    },
    funnelArgv: ["fabdesk-core", "serve", "https://fabplane.com/download?ph_id=ph_from_env"],
    funnelFetch: async (_input, init) => {
      captures.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response("{}", { status: 200 });
    },
    services: async ({ projects, bus, store }) =>
      mockServices([], {
        projects,
        bus: { emit: (e) => bus.emit(e) },
        routeRuns: store.routeRuns,
        channel: "internal",
      }) as unknown as CoreServices,
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

describe("funnel HTTP", () => {
  test("GET /funnel requires a bearer and returns JSON / HTML", async () => {
    expect((await fetch(`${daemon.url}/funnel`)).status).toBe(401);
    const res = await api("/funnel");
    expect(res.status).toBe(200);
    const snap = (await res.json()) as FunnelSnapshot;
    expect(snap.captureEnabled).toBe(true);
    expect(snap.optedIn).toBe(true);
    expect(snap.handoff.phId).toBe("ph_from_env");
    expect(snap.handoff.utmSource).toBe("newsletter");
    expect(snap.events.some((e) => e.event === "onboarding_app_launched")).toBe(true);
    expect(snap.events.some((e) => e.event === "onboarding_landing")).toBe(true);
    const html = await api("/funnel?format=html");
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type") ?? "").toContain("text/html");
    expect(await html.text()).toContain("onboarding_app_launched");
  });

  test("POST /funnel/handoff adopts first-touch fields without overwriting", async () => {
    const res = await api("/funnel/handoff", {
      method: "POST",
      body: JSON.stringify({ ph_id: "ph_ignored", utm_campaign: "try", gclid: "Cjw" }),
    });
    expect(res.status).toBe(200);
    const snap = (await res.json()) as FunnelSnapshot;
    expect(snap.handoff.phId).toBe("ph_from_env");
    expect(snap.handoff.utmCampaign).toBe("try");
    expect(snap.handoff.gclid).toBe("Cjw");
  });

  test("POST /funnel/events allow-lists client review and board events", async () => {
    const allowed = await api("/funnel/events", {
      method: "POST",
      body: JSON.stringify({ event: "onboarding_first_review_viewed", properties: { source: "review" } }),
    });
    expect(allowed.status).toBe(200);
    expect((await allowed.json()) as { recorded: boolean }).toEqual({ recorded: true });
    const again = await api("/funnel/events", {
      method: "POST",
      body: JSON.stringify({ event: "onboarding_first_review_viewed" }),
    });
    expect(again.status).toBe(200);
    expect((await again.json()) as { recorded: boolean }).toEqual({ recorded: false });
    const denied = await api("/funnel/events", {
      method: "POST",
      body: JSON.stringify({ event: "onboarding_first_ai_run" }),
    });
    expect(denied.status).toBe(400);
    expect((await denied.json()) as { recorded: boolean }).toEqual({ recorded: false });
    const board = await api("/funnel/events", {
      method: "POST",
      body: JSON.stringify({ event: "onboarding_first_board_viewed", properties: { source: "pcb" } }),
    });
    expect(board.status).toBe(200);
    expect((await board.json()) as { recorded: boolean }).toEqual({ recorded: true });
  });

  test("creating a project records onboarding_first_project once", async () => {
    const created = await api("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Funnel Board" }),
    });
    expect(created.status).toBe(201);
    const again = await api("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Second Board" }),
    });
    expect(again.status).toBe(201);
    const snap = (await (await api("/funnel")).json()) as FunnelSnapshot;
    expect(snap.events.filter((e) => e.event === "onboarding_first_project")).toHaveLength(1);
  });

  test("productAnalytics off is local and stops new events", async () => {
    const patched = await api("/settings", {
      method: "PATCH",
      body: JSON.stringify({ productAnalytics: false }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { productAnalytics: boolean }).productAnalytics).toBe(false);
    const before = ((await (await api("/funnel")).json()) as FunnelSnapshot).events.length;
    await api("/projects", { method: "POST", body: JSON.stringify({ name: "Ignored" }) });
    const after = (await (await api("/funnel")).json()) as FunnelSnapshot;
    expect(after.optedIn).toBe(false);
    expect(after.events.length).toBe(before);
    await api("/settings", { method: "PATCH", body: JSON.stringify({ productAnalytics: true }) });
  });
});
