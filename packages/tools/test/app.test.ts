import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRegistry, makeContext, type AppBridge, type ToolContext } from "../src";
import { mockServices, tempProject } from "./mock-services";

type Call = { method: string; path: string; body: unknown };

function fakeBridge(handlers: Partial<Record<string, (body: unknown, path: string) => unknown>> = {}): AppBridge & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    status: async () => ({ running: true, url: "http://127.0.0.1:1", pid: 1 }),
    call: async <T,>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
      calls.push({ method, path, body });
      const key = path.split("?")[0]!;
      const h = handlers[key];
      if (!h) throw new Error(`unexpected bridge call ${method} ${path}`);
      return h(body, path) as T;
    },
  };
}

async function setup(bridge?: AppBridge) {
  const project = await tempProject("app");
  const services = mockServices([project], bridge ? { appBridge: bridge } : {});
  const registry = createRegistry();
  const ctx = (): ToolContext => makeContext({ services, project: null });
  const invoke = (name: string, args: unknown = {}) => registry.invoke(name, args, () => ctx());
  return { registry, invoke, project, services };
}

const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

describe("app toolset", () => {
  test("registers under toolset app with the expected annotations", async () => {
    const { registry } = await setup();
    const names = registry.byToolset("app").map((t) => t.name);
    expect(names).toEqual([
      "app_state",
      "app_screenshot",
      "app_find",
      "app_click",
      "app_type",
      "app_key",
      "app_select_project",
      "app_open_tab",
      "app_open_thread",
      "app_new_chat",
      "app_send_message",
      "app_cinema",
      "app_wait_for",
      "app_eval",
    ]);
    expect(registry.get("app_state")!.annotations.readOnlyHint).toBe(true);
    expect(registry.get("app_screenshot")!.annotations.readOnlyHint).toBe(true);
    expect(registry.get("app_click")!.annotations.readOnlyHint).toBeUndefined();
    expect(registry.get("app_eval")!.annotations.destructiveHint).toBe(true);
    expect(registry.get("app_eval")!.annotations.openWorldHint).toBe(true);
    // Global scope: no injected `project` argument.
    expect(Object.keys(registry.inputShape(registry.get("app_state")!))).not.toContain("project");
    expect(registry.manifest().filter((t) => t.toolset === "app")).toHaveLength(14);
  });

  test("every tool reports a clear error when no bridge is configured", async () => {
    const { invoke } = await setup();
    for (const [name, args] of [
      ["app_state", {}],
      ["app_screenshot", {}],
      ["app_find", { query: "x" }],
      ["app_click", { selector: "button" }],
      ["app_type", { text: "hi" }],
      ["app_key", { key: "Enter" }],
      ["app_select_project", { project: "p" }],
      ["app_open_tab", { tab: "cinema" }],
      ["app_open_thread", { thread: "t1" }],
      ["app_new_chat", {}],
      ["app_send_message", { text: "hello" }],
      ["app_cinema", { action: "live" }],
      ["app_wait_for", { predicate: "true" }],
      ["app_eval", { code: "1" }],
    ] as const) {
      await expect(invoke(name, args)).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("automation bridge is not running") });
    }
  });

  test("app_state summarises the bridge response", async () => {
    const bridge = fakeBridge({
      "/state": () => ({
        app: { version: "0.1.0", packaged: false, mode: "dev" },
        windows: [{ id: 1, bounds: { x: 0, y: 0, width: 1440, height: 920 }, focused: true, url: "http://localhost:5173/" }],
        ui: { activeProjectId: "p1", activeThreadId: null, boardTab: "cinema", boardOpen: true, sidebarOpen: true, settingsOpen: false, paletteOpen: false, cinema: { activeRunId: "r1", frames: 12, cursor: 11, viewMode: "board", followLive: true, hiddenLayers: [] }, auth: { state: "local" }, core: { url: "http://127.0.0.1:47831", status: { state: "ready" } } },
      }),
    });
    const { invoke } = await setup(bridge);
    const out = await invoke("app_state");
    expect(out.text).toContain("fabPlane 0.1.0 (dev, automation dev); 1 window(s)");
    expect(out.text).toContain("window 1 (focused): 1440×920");
    expect(out.text).toContain("project=p1 thread=new chat boardTab=cinema");
    expect(out.text).toContain("run=r1 frames=12 cursor=11 view=board");
    expect(bridge.calls).toEqual([{ method: "GET", path: "/state", body: undefined }]);
  });

  test("app_screenshot saves the image and returns it as image content", async () => {
    const bridge = fakeBridge({
      "/screenshot": (body) => ({ mime: (body as { format: string }).format === "png" ? "image/png" : "image/jpeg", base64: tinyPng.toString("base64"), width: 720, height: 460, windowId: 1 }),
    });
    const { invoke } = await setup(bridge);
    const full = await invoke("app_screenshot");
    expect(bridge.calls[0]!.body).toEqual({ scale: 0.5, format: "jpeg" });
    expect(full.images).toHaveLength(1);
    expect(full.images![0]!.mime).toBe("image/jpeg");
    expect(existsSync(full.images![0]!.path)).toBe(true);
    expect(await readFile(full.images![0]!.path)).toEqual(tinyPng);

    const region = await invoke("app_screenshot", { region: { x: 10, y: 20, width: 100, height: 50 } });
    expect(bridge.calls[1]!.body).toEqual({ region: { x: 10, y: 20, width: 100, height: 50 }, scale: 1, format: "png" });
    expect(region.images![0]!.mime).toBe("image/png");
    expect(region.images![0]!.path.endsWith(".png")).toBe(true);
  });

  test("app_find lists refs and app_click passes them through", async () => {
    const bridge = fakeBridge({
      "/find": (_b, path) => {
        const q = new URL(`http://x${path}`).searchParams;
        expect(q.get("query")).toBe("whole board");
        expect(q.get("limit")).toBe("5");
        return { matches: [{ ref: "select:nth-of-type(2) > option:nth-of-type(2)", role: "option", name: "whole board", text: "whole board", testid: null, bounds: { x: 1, y: 2, width: 30, height: 10 }, disabled: false }] };
      },
      "/click": (body) => ({ ...(body as object), x: 16, y: 7, synthetic: true }),
    });
    const { invoke } = await setup(bridge);
    const found = await invoke("app_find", { query: "whole board", limit: 5 });
    expect(found.text).toContain("1 match(es)");
    expect(found.text).toContain("select:nth-of-type(2) > option:nth-of-type(2)");
    const clicked = await invoke("app_click", { selector: "select:nth-of-type(2) > option:nth-of-type(2)" });
    expect(bridge.calls[1]!.body).toEqual({ selector: "select:nth-of-type(2) > option:nth-of-type(2)", button: "left", clickCount: 1 });
    expect(clicked.text).toContain("via its <select>");
  });

  test("app_click requires a selector or coordinates", async () => {
    const { invoke } = await setup(fakeBridge());
    await expect(invoke("app_click", {})).rejects.toMatchObject({ code: "invalid_args" });
    await expect(invoke("app_click", { x: 1 })).rejects.toMatchObject({ code: "invalid_args" });
  });

  test("ui actions go through POST /ui with dotted actions for cinema", async () => {
    const bridge = fakeBridge({
      "/ui": (body) => {
        const { action } = body as { action: string; args: unknown[] };
        if (action === "sendMessage") return { result: { sent: true, threadId: "t9" } };
        if (action === "waitFor") return { result: { ok: false, elapsedMs: 100 } };
        return { result: { activeRunId: "r1", frames: 3, cursor: 1, viewMode: "board", hiddenLayers: [2], projectId: "p_app" } };
      },
    });
    const { invoke } = await setup(bridge);
    await invoke("app_select_project", { project: "app" });
    expect(bridge.calls.at(-1)!.body).toEqual({ action: "selectProject", args: ["p_app"] });
    await invoke("app_select_project", { project: "unknown-ref" });
    expect(bridge.calls.at(-1)!.body).toEqual({ action: "selectProject", args: ["unknown-ref"] });
    await invoke("app_open_tab", { tab: "cinema" });
    expect(bridge.calls.at(-1)!.body).toEqual({ action: "openTab", args: ["cinema"] });
    await expect(invoke("app_open_tab", { tab: "nope" })).rejects.toMatchObject({ code: "invalid_args" });
    await invoke("app_open_thread", { thread: "t1" });
    expect(bridge.calls.at(-1)!.body).toEqual({ action: "openThread", args: ["t1"] });
    await invoke("app_new_chat");
    expect(bridge.calls.at(-1)!.body).toEqual({ action: "newChat", args: [] });
    const sent = await invoke("app_send_message", { text: "hello", agent: "claude" });
    expect(bridge.calls.at(-1)!.body).toEqual({ action: "sendMessage", args: ["hello", "claude"] });
    expect(sent.isError).toBeFalsy();
    expect(sent.text).toContain("thread t9");

    await invoke("app_cinema", { action: "view", mode: "board" });
    expect(bridge.calls.at(-1)!.body).toEqual({ action: "cinema.setView", args: ["board"] });
    await invoke("app_cinema", { action: "seek", index: 4 });
    expect(bridge.calls.at(-1)!.body).toEqual({ action: "cinema.seek", args: [4] });
    await invoke("app_cinema", { action: "live" });
    expect(bridge.calls.at(-1)!.body).toEqual({ action: "cinema.goLive", args: [] });
    await invoke("app_cinema", { action: "load", run: "run_1" });
    expect(bridge.calls.at(-1)!.body).toEqual({ action: "cinema.load", args: ["run_1"] });
    await expect(invoke("app_cinema", { action: "load" })).rejects.toMatchObject({ code: "invalid_args" });
    const layer = await invoke("app_cinema", { action: "layer", layer: 2 });
    expect(bridge.calls.at(-1)!.body).toEqual({ action: "cinema.toggleLayer", args: [2] });
    expect(layer.text).toContain("hiddenLayers=[2]");
    await expect(invoke("app_cinema", { action: "view" })).rejects.toMatchObject({ code: "invalid_args" });

    const waited = await invoke("app_wait_for", { predicate: "state.boardTab === 'pcb'", timeoutMs: 100 });
    expect(bridge.calls.at(-1)!.body).toEqual({ action: "waitFor", args: ["state.boardTab === 'pcb'", 100] });
    expect(waited.isError).toBe(true);
  });

  test("app_type, app_key and app_eval forward to the bridge", async () => {
    const bridge = fakeBridge({
      "/type": (body) => ({ ...(body as object), typed: 5 }),
      "/key": (body) => ({ ...(body as object) }),
      "/eval": () => ({ result: { a: 1 } }),
    });
    const { invoke } = await setup(bridge);
    await invoke("app_type", { text: "hello", selector: "textarea" });
    expect(bridge.calls.at(-1)!.body).toEqual({ text: "hello", selector: "textarea" });
    await invoke("app_key", { key: "CommandOrControl+K" });
    expect(bridge.calls.at(-1)!.body).toEqual({ key: "CommandOrControl+K" });
    // Off by default: arbitrary JavaScript reaches the host bridge (restartCore).
    const before = bridge.calls.length;
    await expect(invoke("app_eval", { code: "({a:1})" })).rejects.toMatchObject({ code: "precondition" });
    expect(bridge.calls.length).toBe(before);
    process.env["FABDESK_APP_EVAL"] = "1";
    try {
      const ev = await invoke("app_eval", { code: "({a:1})" });
      expect(bridge.calls.at(-1)!.body).toEqual({ code: "({a:1})", timeoutMs: 10_000 });
      expect(ev.text).toBe(JSON.stringify({ a: 1 }, null, 2));
    } finally {
      delete process.env["FABDESK_APP_EVAL"];
    }
  });
});
