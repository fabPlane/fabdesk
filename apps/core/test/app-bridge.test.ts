import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolError } from "@fabdesk/tools";
import { AppBridgeClient, locateAppBridgeFile, parseAppBridgeFile } from "../src/app-bridge";

const TOKEN = "secret-token";
const requests: Array<{ method: string; path: string; auth: string | null; body: unknown }> = [];

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const auth = req.headers.get("authorization");
    requests.push({ method: req.method, path: url.pathname + url.search, auth, body: req.method === "POST" ? await req.json() : undefined });
    if (auth !== `Bearer ${TOKEN}`) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (url.pathname === "/state") return Response.json({ app: { version: "0.1.0" }, windows: [], ui: null });
    if (url.pathname === "/boom") return Response.json({ error: "no such window" }, { status: 404 });
    if (url.pathname === "/bad") return Response.json({ error: "selector required" }, { status: 400 });
    if (url.pathname === "/ui") return Response.json({ result: { echoed: await Promise.resolve(requests.at(-1)!.body) } });
    return new Response("nope", { status: 500 });
  },
});
afterAll(() => server.stop(true));

async function bridgeFile(contents: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fabdesk-app-bridge-"));
  const file = join(dir, "app-bridge.json");
  await writeFile(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  return file;
}

describe("app bridge client", () => {
  test("locates the file next to the handshake or from the env override", () => {
    expect(locateAppBridgeFile("/x/y/daemon.json", {})).toBe("/x/y/app-bridge.json");
    expect(locateAppBridgeFile("/x/y/daemon.json", { FABDESK_APP_BRIDGE_FILE: "/else/bridge.json" })).toBe("/else/bridge.json");
    expect(locateAppBridgeFile("/x/y/daemon.json", { FABDESK_APP_BRIDGE_FILE: "  " })).toBe("/x/y/app-bridge.json");
  });

  test("parses only loopback bridge files", () => {
    expect(parseAppBridgeFile(JSON.stringify({ url: "http://127.0.0.1:4321/", pid: 12, startedAt: "t" }))).toEqual({ url: "http://127.0.0.1:4321", pid: 12, startedAt: "t" });
    expect(parseAppBridgeFile(JSON.stringify({ url: "http://evil.example:80", pid: 12 }))).toBeNull();
    expect(parseAppBridgeFile(JSON.stringify({ url: "http://127.0.0.1:4321" }))).toBeNull();
    expect(parseAppBridgeFile("garbage")).toBeNull();
  });

  test("reports unavailable without a file, with a dead pid, or with the wrong token", async () => {
    const missing = new AppBridgeClient({ file: "/nonexistent/app-bridge.json", token: TOKEN });
    expect((await missing.status()).running).toBe(false);
    await expect(missing.call("GET", "/state")).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("no app-bridge.json") });

    const dead = new AppBridgeClient({ file: await bridgeFile({ url: server.url.origin, pid: 999_999, startedAt: "" }), token: TOKEN, pidAlive: () => false });
    expect((await dead.status()).reason).toContain("is gone");

    const wrong = new AppBridgeClient({ file: await bridgeFile({ url: server.url.origin, pid: process.pid, startedAt: "" }), token: "other", pidAlive: () => true });
    expect((await wrong.status()).reason).toContain("token");
    await expect(wrong.call("GET", "/state")).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("token") });

    const gone = new AppBridgeClient({ file: await bridgeFile({ url: "http://127.0.0.1:1", pid: process.pid, startedAt: "" }), token: TOKEN, pidAlive: () => true, timeoutMs: 500 });
    await expect(gone.call("GET", "/state")).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("unreachable") });
  });

  test("forwards requests with the bearer and maps error statuses", async () => {
    const client = new AppBridgeClient({ file: await bridgeFile({ url: `${server.url.origin}/`, pid: process.pid, startedAt: "" }), token: TOKEN, pidAlive: () => true });
    expect(await client.status()).toEqual({ running: true, url: server.url.origin, pid: process.pid });
    const state = await client.call<{ app: { version: string } }>("GET", "/state");
    expect(state.app.version).toBe("0.1.0");
    const echoed = await client.call<{ result: { echoed: unknown } }>("POST", "/ui", { action: "openTab", args: ["pcb"] });
    expect(echoed.result.echoed).toEqual({ action: "openTab", args: ["pcb"] });
    expect(requests.at(-1)).toMatchObject({ method: "POST", path: "/ui", auth: `Bearer ${TOKEN}` });

    const notFound = await client.call("GET", "/boom").catch((e: unknown) => e);
    expect(notFound).toBeInstanceOf(ToolError);
    expect((notFound as ToolError).code).toBe("not_found");
    expect((notFound as ToolError).message).toContain("no such window");
    const bad = await client.call("POST", "/bad", {}).catch((e: unknown) => e);
    expect((bad as ToolError).code).toBe("invalid_args");
    const internal = await client.call("GET", "/other").catch((e: unknown) => e);
    expect((internal as ToolError).code).toBe("internal");
    expect((internal as ToolError).message).toContain("nope");
  });
});
