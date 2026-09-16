import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import {
  BridgeError,
  authorized,
  chooseWindow,
  evalInWindow,
  handleBridgeRequest,
  isLoopbackAddress,
  keyEventsFor,
  originAllowed,
  parseAccelerator,
  startBridgeServer,
  typeEventsFor,
  type AutomationDeps,
  type AutomationWindow,
  type BridgeServer,
  type CapturedImage,
  type InputEvent,
  type Rect,
} from "./automation-server";

function fakeImage(width: number, height: number): CapturedImage {
  return {
    size: () => ({ width, height }),
    resize: (w, h) => fakeImage(w, h),
    png: () => Buffer.from(`png:${width}x${height}`),
    jpeg: (q) => Buffer.from(`jpeg${q}:${width}x${height}`),
  };
}

type FakeWindow = AutomationWindow & { events: InputEvent[]; evals: string[]; captures: Array<Rect | undefined>; focusCalls: number; api: boolean; page: Record<string, unknown> };

/**
 * Simulates `executeJavaScript` by evaluating the wrapped code with a tiny stand-in for the page
 * (`window.__fabdeskApp`, `document.querySelector`), enough to exercise the bridge's page-side snippets.
 */
function fakeWindow(id: number, opts: { focused?: boolean; api?: boolean } = {}): FakeWindow {
  const w: FakeWindow = {
    id,
    events: [],
    evals: [],
    captures: [],
    focusCalls: 0,
    api: opts.api ?? true,
    page: {},
    isDestroyed: () => false,
    isFocused: () => opts.focused ?? false,
    bounds: () => ({ x: 10, y: 20, width: 1440, height: 920 }),
    title: () => `win ${id}`,
    url: () => "http://localhost:5173/",
    capture: async (rect) => {
      w.captures.push(rect);
      return fakeImage(rect?.width ?? 1440, rect?.height ?? 920);
    },
    focus: () => {
      w.focusCalls += 1;
    },
    sendInputEvent: (ev) => {
      w.events.push(ev);
    },
    executeJavaScript: async (code) => {
      w.evals.push(code);
      const api = w.api
        ? {
            state: () => ({ boardTab: "cinema", activeProjectId: "p1" }),
            find: (q: string, limit: number) => [{ ref: `[data-testid="${q}"]`, role: "button", name: q, text: q, testid: q, bounds: { x: 1, y: 2, width: 3, height: 4 }, disabled: false, limit }],
            __invoke: (action: string, args: unknown[]) => ({ action, args }),
          }
        : undefined;
      const elements: Record<string, unknown> = {
        "#btn": { tagName: "BUTTON", scrollIntoView() {}, getBoundingClientRect: () => ({ left: 100, top: 200, width: 40, height: 20 }), focus() {} },
        "select > option:nth-of-type(2)": (() => {
          const select = { value: "", dispatched: [] as string[], dispatchEvent(e: { type: string }) { select.dispatched.push(e.type); return true; } };
          return { tagName: "OPTION", value: "board", closest: () => select, __select: select };
        })(),
        textarea: { tagName: "TEXTAREA", value: "abc", scrollIntoView() {}, focus() {}, setSelectionRange(a: number, b: number) { w.page["selection"] = [a, b]; } },
      };
      const document = {
        querySelector: (sel: string) => (sel in elements ? elements[sel] : null),
        get activeElement() {
          return elements["textarea"];
        },
      };
      const HTMLSelectElement = { prototype: {} };
      Object.defineProperty(HTMLSelectElement.prototype, "value", { set(v: string) { (this as { value: string }).value = v; }, configurable: true });
      const Event = class { constructor(public type: string, public init?: unknown) {} };
      return runInNewContext(`(${code})`, { window: { __fabdeskApp: api }, document, HTMLSelectElement, Event });
    },
  };
  return w;
}

function deps(windows: FakeWindow[], token: string | null = "tok"): AutomationDeps {
  return { version: "0.1.0", packaged: false, platform: "darwin", mode: "dev", pid: 4242, windows: () => windows, token: () => token };
}

const req = (method: string, path: string, body?: unknown, query: Record<string, string> = {}) => ({ method, path, query: new URLSearchParams(query), body });

describe("guards", () => {
  test("loopback and origin checks", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("10.0.0.5")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(originAllowed(null)).toBe(true);
    expect(originAllowed(undefined)).toBe(true);
    expect(originAllowed("http://localhost:5173")).toBe(true);
    expect(originAllowed("http://127.0.0.1:4000")).toBe(true);
    expect(originAllowed("https://evil.example")).toBe(false);
    expect(originAllowed("null")).toBe(false);
    expect(originAllowed("garbage")).toBe(false);
  });

  test("bearer auth is exact and constant-length", () => {
    expect(authorized("Bearer tok", "tok")).toBe(true);
    expect(authorized("bearer tok", "tok")).toBe(true);
    expect(authorized("Bearer tok2", "tok")).toBe(false);
    expect(authorized("Bearer to", "tok")).toBe(false);
    expect(authorized("tok", "tok")).toBe(false);
    expect(authorized("Bearer tok", null)).toBe(false);
    expect(authorized(undefined, "tok")).toBe(false);
  });

  test("accelerators map to Electron key codes and modifiers", () => {
    expect(parseAccelerator("Enter", "darwin")).toEqual({ keyCode: "Return", modifiers: [] });
    expect(parseAccelerator("Escape", "linux")).toEqual({ keyCode: "Escape", modifiers: [] });
    expect(parseAccelerator("CommandOrControl+K", "darwin")).toEqual({ keyCode: "K", modifiers: ["meta"] });
    expect(parseAccelerator("CommandOrControl+K", "win32")).toEqual({ keyCode: "K", modifiers: ["control"] });
    expect(parseAccelerator("Ctrl+Shift+ArrowDown", "linux")).toEqual({ keyCode: "Down", modifiers: ["control", "shift"] });
    expect(parseAccelerator("Shift++", "linux")).toEqual({ keyCode: "+", modifiers: ["shift"] });
    expect(parseAccelerator("f5", "linux")).toEqual({ keyCode: "F5", modifiers: [] });
    expect(() => parseAccelerator("Hyper+K", "linux")).toThrow(BridgeError);
    expect(() => parseAccelerator("  ", "linux")).toThrow(BridgeError);
  });

  test("key and text events", () => {
    expect(keyEventsFor("a", []).map((e) => e.type)).toEqual(["keyDown", "char", "keyUp"]);
    expect(keyEventsFor("K", ["meta"]).map((e) => e.type)).toEqual(["keyDown", "keyUp"]);
    expect(keyEventsFor("Return", []).map((e) => e.type)).toEqual(["keyDown", "keyUp"]);
    const evs = typeEventsFor("ab\n\t");
    expect(evs.filter((e) => e.type === "char").map((e) => e["keyCode"])).toEqual(["a", "b", "Return"]);
    expect(evs.find((e) => e["keyCode"] === "Return")!["modifiers"]).toEqual(["shift"]);
    expect(evs.filter((e) => e["keyCode"] === "Tab")).toHaveLength(2);
  });

  test("window selection prefers focused, then first, and validates ids", () => {
    const a = fakeWindow(1);
    const b = fakeWindow(2, { focused: true });
    expect(chooseWindow([a, b]).id).toBe(2);
    expect(chooseWindow([a]).id).toBe(1);
    expect(chooseWindow([a, b], 1).id).toBe(1);
    expect(() => chooseWindow([a, b], 9)).toThrow(/no window with id 9/);
    expect(() => chooseWindow([])).toThrow(/no app window/);
  });
});

describe("eval", () => {
  test("expression and statement forms, JSON-forced results, in-page errors", async () => {
    const w = fakeWindow(1);
    expect(await evalInWindow(w, "1 + 1")).toEqual({ ok: true, value: 2 });
    expect(await evalInWindow(w, "const x = 2; return { x, u: undefined }")).toEqual({ ok: true, value: { x: 2 } });
    expect(await evalInWindow(w, "undefined")).toEqual({ ok: true, value: null });
    const bad = await evalInWindow(w, "(() => { throw new Error('boom') })()");
    expect(bad.ok).toBe(false);
    expect((bad as { error: string }).error).toContain("boom");
    await expect(evalInWindow(w, "x".repeat(70_000))).rejects.toThrow(/exceeds/);
  });

  test("times out", async () => {
    const w = fakeWindow(1);
    w.executeJavaScript = () => new Promise(() => {});
    await expect(evalInWindow(w, "1", 50)).rejects.toMatchObject({ status: 504 });
  });
});

describe("routes", () => {
  test("GET /state lists windows and the renderer snapshot", async () => {
    const w = fakeWindow(1, { focused: true });
    const out = await handleBridgeRequest(req("GET", "/state"), deps([w]));
    expect(out.status).toBe(200);
    const body = out.body as Record<string, unknown>;
    expect(body["app"]).toEqual({ version: "0.1.0", packaged: false, platform: "darwin", mode: "dev", pid: 4242 });
    expect(body["windows"]).toEqual([{ id: 1, bounds: { x: 10, y: 20, width: 1440, height: 920 }, focused: true, url: "http://localhost:5173/", title: "win 1" }]);
    expect(body["ui"]).toEqual({ boardTab: "cinema", activeProjectId: "p1" });
  });

  test("GET /state degrades without the renderer API", async () => {
    const w = fakeWindow(1, { api: false });
    const body = (await handleBridgeRequest(req("GET", "/state"), deps([w]))).body as Record<string, unknown>;
    expect(body["ui"]).toBeNull();
    expect(String(body["uiError"])).toContain("not installed");
    await expect(handleBridgeRequest(req("GET", "/find", undefined, { query: "x" }), deps([w]))).rejects.toMatchObject({ status: 503 });
  });

  test("POST /screenshot scales, crops and picks formats", async () => {
    const w = fakeWindow(1);
    const full = (await handleBridgeRequest(req("POST", "/screenshot", { scale: 0.5, format: "jpeg" }), deps([w]))).body as Record<string, unknown>;
    expect(full).toMatchObject({ mime: "image/jpeg", width: 720, height: 460, windowId: 1 });
    expect(Buffer.from(full["base64"] as string, "base64").toString()).toBe("jpeg80:720x460");
    expect(w.captures[0]).toBeUndefined();
    const region = (await handleBridgeRequest(req("POST", "/screenshot", { region: { x: 5, y: 6, width: 100, height: 40 } }), deps([w]))).body as Record<string, unknown>;
    expect(region).toMatchObject({ mime: "image/png", width: 100, height: 40 });
    expect(w.captures[1]).toEqual({ x: 5, y: 6, width: 100, height: 40 });
    await expect(handleBridgeRequest(req("POST", "/screenshot", { scale: 2 }), deps([w]))).rejects.toMatchObject({ status: 400 });
    await expect(handleBridgeRequest(req("POST", "/screenshot", { region: { x: 0, y: 0, width: 0, height: 1 } }), deps([w]))).rejects.toMatchObject({ status: 400 });
    await expect(handleBridgeRequest(req("POST", "/screenshot", { format: "gif" }), deps([w]))).rejects.toMatchObject({ status: 400 });
  });

  test("POST /click by selector sends real mouse events at the element centre", async () => {
    const w = fakeWindow(1);
    const out = (await handleBridgeRequest(req("POST", "/click", { selector: "#btn", clickCount: 2 }), deps([w]))).body as Record<string, unknown>;
    expect(out).toMatchObject({ selector: "#btn", x: 120, y: 210, synthetic: false, tag: "button", clickCount: 2 });
    expect(w.focusCalls).toBe(1);
    expect(w.events.map((e) => [e.type, e["clickCount"]])).toEqual([["mouseMove", undefined], ["mouseDown", 1], ["mouseUp", 1], ["mouseDown", 2], ["mouseUp", 2]]);
    expect(w.events[1]).toMatchObject({ x: 120, y: 210, button: "left" });
  });

  test("POST /click by coordinates and error cases", async () => {
    const w = fakeWindow(1);
    const out = (await handleBridgeRequest(req("POST", "/click", { x: 3.4, y: 7.6, button: "right" }), deps([w]))).body as Record<string, unknown>;
    expect(out).toMatchObject({ x: 3, y: 8, button: "right", clickCount: 1 });
    await expect(handleBridgeRequest(req("POST", "/click", {}), deps([w]))).rejects.toMatchObject({ status: 400 });
    await expect(handleBridgeRequest(req("POST", "/click", { selector: "#missing" }), deps([w]))).rejects.toMatchObject({ status: 404 });
    await expect(handleBridgeRequest(req("POST", "/click", { x: 1, y: 1, button: "back" }), deps([w]))).rejects.toMatchObject({ status: 400 });
  });

  test("POST /click on an <option> selects it through its <select> without mouse events", async () => {
    const w = fakeWindow(1);
    const out = (await handleBridgeRequest(req("POST", "/click", { selector: "select > option:nth-of-type(2)" }), deps([w]))).body as Record<string, unknown>;
    expect(out).toMatchObject({ synthetic: true, tag: "option", value: "board" });
    expect(w.events).toHaveLength(0);
  });

  test("POST /type focuses the selector then types", async () => {
    const w = fakeWindow(1);
    const out = (await handleBridgeRequest(req("POST", "/type", { text: "hi", selector: "textarea" }), deps([w]))).body as Record<string, unknown>;
    expect(out).toMatchObject({ typed: 2, events: 6, selector: "textarea", focused: { tag: "textarea", focused: true } });
    expect(w.page["selection"]).toEqual([3, 3]);
    expect(w.events.map((e) => e.type)).toEqual(["keyDown", "char", "keyUp", "keyDown", "char", "keyUp"]);
    await expect(handleBridgeRequest(req("POST", "/type", { text: "" }), deps([w]))).rejects.toMatchObject({ status: 400 });
    await expect(handleBridgeRequest(req("POST", "/type", { text: "x", selector: "#missing" }), deps([w]))).rejects.toMatchObject({ status: 404 });
  });

  test("POST /key presses an accelerator", async () => {
    const w = fakeWindow(1);
    const out = (await handleBridgeRequest(req("POST", "/key", { key: "CommandOrControl+K" }), deps([w]))).body as Record<string, unknown>;
    expect(out).toEqual({ key: "CommandOrControl+K", keyCode: "K", modifiers: ["meta"] });
    expect(w.events).toEqual([{ type: "keyDown", keyCode: "K", modifiers: ["meta"] }, { type: "keyUp", keyCode: "K", modifiers: ["meta"] }]);
    w.events.length = 0;
    await handleBridgeRequest(req("POST", "/key", { key: "Enter" }), deps([w]));
    expect(w.events.map((e) => e.type)).toEqual(["keyDown", "keyUp"]);
  });

  test("POST /ui and GET /find go through the renderer API", async () => {
    const w = fakeWindow(1);
    const ui = (await handleBridgeRequest(req("POST", "/ui", { action: "cinema.setView", args: ["board"] }), deps([w]))).body;
    expect(ui).toEqual({ result: { action: "cinema.setView", args: ["board"] } });
    await expect(handleBridgeRequest(req("POST", "/ui", { action: "alert(1)" }), deps([w]))).rejects.toMatchObject({ status: 400 });
    const find = (await handleBridgeRequest(req("GET", "/find", undefined, { query: "Route Cinema", limit: "3" }), deps([w]))).body as Record<string, unknown>;
    expect(find["query"]).toBe("Route Cinema");
    expect((find["matches"] as Array<Record<string, unknown>>)[0]).toMatchObject({ ref: '[data-testid="Route Cinema"]', limit: 3 });
    await expect(handleBridgeRequest(req("GET", "/find"), deps([w]))).rejects.toMatchObject({ status: 400 });
  });

  test("POST /ui waitFor polls a predicate from main", async () => {
    const w = fakeWindow(1);
    const hit = (await handleBridgeRequest(req("POST", "/ui", { action: "waitFor", args: ["state.boardTab === 'cinema' && state", 500] }), deps([w]))).body as { result: { ok: boolean; value: unknown } };
    expect(hit.result.ok).toBe(true);
    expect(hit.result.value).toEqual({ boardTab: "cinema", activeProjectId: "p1" });
    const miss = (await handleBridgeRequest(req("POST", "/ui", { action: "waitFor", args: ["state.boardTab === 'pcb'", 250] }), deps([w]))).body as { result: { ok: boolean; elapsedMs: number } };
    expect(miss.result.ok).toBe(false);
    expect(miss.result.elapsedMs).toBeGreaterThanOrEqual(250);
    const bad = (await handleBridgeRequest(req("POST", "/ui", { action: "waitFor", args: ["nope.x", 150] }), deps([w]))).body as { result: { ok: boolean; error?: string } };
    expect(bad.result.ok).toBe(false);
    expect(bad.result.error).toContain("nope");
    await expect(handleBridgeRequest(req("POST", "/ui", { action: "waitFor", args: [] }), deps([w]))).rejects.toMatchObject({ status: 400 });
    await expect(handleBridgeRequest(req("POST", "/ui", { action: "waitFor", args: ["true"] }), deps([fakeWindow(1, { api: false })]))).rejects.toMatchObject({ status: 503 });
  });

  test("POST /eval returns results and 422 for page errors", async () => {
    const w = fakeWindow(1);
    expect((await handleBridgeRequest(req("POST", "/eval", { code: "({a: 1})" }), deps([w]))).body).toEqual({ result: { a: 1 } });
    const err = await handleBridgeRequest(req("POST", "/eval", { code: "throw new Error('nope')" }), deps([w]));
    expect(err.status).toBe(422);
    expect(String((err.body as { error: string }).error)).toContain("nope");
    await expect(handleBridgeRequest(req("POST", "/eval", {}), deps([w]))).rejects.toMatchObject({ status: 400 });
  });

  test("windowId selects the target and unknown routes 404", async () => {
    const a = fakeWindow(1, { focused: true });
    const b = fakeWindow(2);
    await handleBridgeRequest(req("POST", "/key", { key: "Escape", windowId: 2 }), deps([a, b]));
    expect(a.events).toHaveLength(0);
    expect(b.events).toHaveLength(2);
    await expect(handleBridgeRequest(req("GET", "/nope"), deps([a]))).rejects.toMatchObject({ status: 404 });
  });
});

describe("http server", () => {
  let server: BridgeServer;
  const win = fakeWindow(1, { focused: true });
  let token: string | null = "secret";
  beforeAll(async () => {
    server = await startBridgeServer({ ...deps([win]), token: () => token });
  });
  afterAll(() => server.close());

  test("binds loopback on a random port and enforces auth + origin", async () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(`${server.url}/state`)).status).toBe(401);
    expect((await fetch(`${server.url}/state`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(`${server.url}/state`, { headers: { authorization: "Bearer secret", origin: "https://evil.example" } })).status).toBe(403);
    const ok = await fetch(`${server.url}/state`, { headers: { authorization: "Bearer secret", origin: "http://localhost:5173" } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { windows: unknown[] }).windows).toHaveLength(1);
  });

  test("routes POST bodies, maps BridgeError statuses and rejects bad JSON", async () => {
    const res = await fetch(`${server.url}/key`, { method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: JSON.stringify({ key: "Escape" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: "Escape", keyCode: "Escape", modifiers: [] });
    const bad = await fetch(`${server.url}/key`, { method: "POST", headers: { authorization: "Bearer secret" }, body: "{not json" });
    expect(bad.status).toBe(400);
    const missing = await fetch(`${server.url}/click`, { method: "POST", headers: { authorization: "Bearer secret" }, body: JSON.stringify({ selector: "#missing" }) });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toContain("#missing");
    expect((await fetch(`${server.url}/nope`, { headers: { authorization: "Bearer secret" } })).status).toBe(404);
  });

  test("token changes are picked up live; null token means 401", async () => {
    token = null;
    expect((await fetch(`${server.url}/state`, { headers: { authorization: "Bearer secret" } })).status).toBe(401);
    token = "rotated";
    expect((await fetch(`${server.url}/state`, { headers: { authorization: "Bearer rotated" } })).status).toBe(200);
  });
});
