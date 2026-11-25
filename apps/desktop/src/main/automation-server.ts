/**
 * App automation bridge: a loopback HTTP server the core's `app` toolset talks to (docs/app-automation.md).
 * Pure request handling over an abstract window (`AutomationWindow`) so it can be tested without
 * Electron; `automation.ts` adapts BrowserWindow/webContents and owns the lifecycle.
 *
 * Security model: 127.0.0.1 only, bearer = the daemon token, no foreign `Origin`, and only enabled
 * in dev builds or with FABDESK_AUTOMATION=1.
 */
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Script } from "node:vm";

export type Rect = { x: number; y: number; width: number; height: number };
export type MouseButton = "left" | "right" | "middle";
export type InputEvent = { type: "mouseMove" | "mouseDown" | "mouseUp" | "keyDown" | "keyUp" | "char"; [k: string]: unknown };

export interface CapturedImage {
  size(): { width: number; height: number };
  resize(width: number, height: number): CapturedImage;
  png(): Buffer;
  jpeg(quality: number): Buffer;
}

/** The slice of BrowserWindow/webContents the bridge needs. */
export interface AutomationWindow {
  id: number;
  isDestroyed(): boolean;
  isFocused(): boolean;
  bounds(): Rect;
  title(): string;
  url(): string;
  capture(rect?: Rect): Promise<CapturedImage>;
  executeJavaScript(code: string, userGesture: boolean): Promise<unknown>;
  sendInputEvent(ev: InputEvent): void;
  focus(): void;
}

export interface AutomationDeps {
  version: string;
  packaged: boolean;
  platform: NodeJS.Platform;
  /** How the bridge got enabled. */
  mode: "dev" | "env";
  pid: number;
  windows(): AutomationWindow[];
  /** Current daemon token; null until the core is ready (every request is then 401). */
  token(): string | null;
}

export type BridgeRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
};
export type BridgeResponse = { status: number; body: unknown };

export class BridgeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export const MAX_EVAL_CHARS = 64_000;
export const EVAL_TIMEOUT_MS = 10_000;
export const MAX_BODY_BYTES = 1024 * 1024;
export const JPEG_QUALITY = 80;

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1" || addr.startsWith("127.");
}

/** No Origin (curl, fetch from Node) is fine; a browser Origin must be loopback. */
export function originAllowed(origin: string | null | undefined): boolean {
  if (!origin || origin === "null") return !origin;
  try {
    const u = new URL(origin);
    return (u.protocol === "http:" || u.protocol === "https:") && (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]" || u.hostname === "::1");
  } catch {
    return false;
  }
}

export function authorized(header: string | null | undefined, token: string | null): boolean {
  if (!token || !header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  const given = Buffer.from(m[1]!);
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

const MODIFIER_NAMES: Record<string, string | ((platform: NodeJS.Platform) => string)> = {
  cmd: "meta",
  command: "meta",
  meta: "meta",
  super: "meta",
  ctrl: "control",
  control: "control",
  alt: "alt",
  option: "alt",
  shift: "shift",
  commandorcontrol: (p) => (p === "darwin" ? "meta" : "control"),
  cmdorctrl: (p) => (p === "darwin" ? "meta" : "control"),
};

const KEY_ALIASES: Record<string, string> = {
  enter: "Return",
  return: "Return",
  esc: "Escape",
  escape: "Escape",
  arrowdown: "Down",
  arrowup: "Up",
  arrowleft: "Left",
  arrowright: "Right",
  down: "Down",
  up: "Up",
  left: "Left",
  right: "Right",
  space: "Space",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
};

/** `CommandOrControl+Shift+K` → Electron `sendInputEvent` key code + modifiers. */
export function parseAccelerator(key: string, platform: NodeJS.Platform): { keyCode: string; modifiers: string[] } {
  const raw = key.trim();
  if (!raw) throw new BridgeError(400, "key is required");
  // "Shift++" means shift + the plus key.
  const parts = raw.endsWith("++") ? [...raw.slice(0, -2).split("+"), "+"] : raw.split("+");
  const modifiers: string[] = [];
  const last = parts.pop() ?? "";
  for (const p of parts) {
    const mod = MODIFIER_NAMES[p.trim().toLowerCase()];
    if (!mod) throw new BridgeError(400, `unknown modifier "${p}" in "${key}"`);
    const name = typeof mod === "function" ? mod(platform) : mod;
    if (!modifiers.includes(name)) modifiers.push(name);
  }
  const trimmed = last.trim();
  if (!trimmed && last !== "+") throw new BridgeError(400, `no key in "${key}"`);
  const keyCode = last === "+" ? "+" : trimmed.length === 1 ? trimmed : (KEY_ALIASES[trimmed.toLowerCase()] ?? (/^f\d{1,2}$/i.test(trimmed) ? trimmed.toUpperCase() : trimmed));
  return { keyCode, modifiers };
}

export function chooseWindow(windows: AutomationWindow[], windowId?: number): AutomationWindow {
  const live = windows.filter((w) => !w.isDestroyed());
  if (windowId !== undefined) {
    const w = live.find((x) => x.id === windowId);
    if (!w) throw new BridgeError(404, `no window with id ${windowId}`);
    return w;
  }
  const w = live.find((x) => x.isFocused()) ?? live[0];
  if (!w) throw new BridgeError(503, "no app window");
  return w;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

type EvalResult = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Parse without executing in the main process: prefer the expression form, then a statement
 * body (where `return` is allowed). Sending an invalid probe to Electron triggers the page's
 * global error handler even when the statement fallback succeeds. Execute just the selected
 * form in the renderer; catch runtime errors in-page so their messages survive IPC.
 * Results are forced through JSON so they are serialisable.
 */
export async function evalInWindow(win: AutomationWindow, code: string, timeoutMs = EVAL_TIMEOUT_MS): Promise<EvalResult> {
  if (code.length > MAX_EVAL_CHARS) throw new BridgeError(400, `code exceeds ${MAX_EVAL_CHARS} characters`);
  const expression = `(async () => (\n${code}\n))()`;
  const statements = `(async () => {\n${code}\n})()`;
  const wrap = (inner: string) =>
    `(async () => { try { const __v = await ${inner}; return { ok: true, value: __v === undefined ? null : JSON.parse(JSON.stringify(__v)) }; } catch (e) { return { ok: false, error: e && e.stack ? String(e.stack) : String(e) }; } })()`;
  let parseError: SyntaxError | undefined;
  for (const form of [expression, statements]) {
    const script = wrap(form);
    try {
      new Script(script);
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      parseError = e;
      continue;
    }
    try {
      return (await withTimeout(win.executeJavaScript(script, true), timeoutMs)) as EvalResult;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/timed out/.test(msg)) throw new BridgeError(504, msg);
      return { ok: false, error: `script execution failed: ${msg}` };
    }
  }
  return { ok: false, error: `script did not parse: ${parseError?.message ?? "invalid JavaScript"}` };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`eval timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Calls into the renderer automation API (`window.__fabdeskApp`, installed by src/renderer/automation.ts). */
/** UI actions (`send` waits up to 20 s for the core to accept the message) need more than the eval default. */
export const UI_ACTION_TIMEOUT_MS = 30_000;

async function rendererApi<T>(win: AutomationWindow, expr: string, timeoutMs = EVAL_TIMEOUT_MS): Promise<T> {
  const res = await evalInWindow(win, `(() => { if (!window.__fabdeskApp) throw new Error("__NO_API__"); return (${expr}); })()`, timeoutMs);
  if (!res.ok) {
    if (res.error.includes("__NO_API__")) throw new BridgeError(503, "renderer automation API not installed (window still loading, or the app was started without the automation flag)");
    throw new BridgeError(500, res.error);
  }
  return res.value as T;
}

/** Page-side helper: element centre for a selector; options are applied to their <select> instead. */
const CLICK_TARGET_JS = (selector: string) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  const tag = el.tagName.toLowerCase();
  if (tag === "option") {
    const select = el.closest("select");
    if (!select) return { handled: false, error: "option outside a select" };
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setter.call(select, el.value);
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return { handled: true, tag, value: el.value };
  }
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
  const r = el.getBoundingClientRect();
  return { handled: false, tag, x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };
})()`;

const FOCUS_JS = (selector: string) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
  if (typeof el.focus === "function") el.focus();
  try { if (typeof el.setSelectionRange === "function" && typeof el.value === "string") el.setSelectionRange(el.value.length, el.value.length); } catch {}
  return { tag: el.tagName.toLowerCase(), focused: document.activeElement === el };
})()`;

function windowInfo(w: AutomationWindow) {
  return { id: w.id, bounds: w.bounds(), focused: w.isFocused(), url: w.url(), title: w.title() };
}

async function screenshot(win: AutomationWindow, body: Record<string, unknown>) {
  const region = body["region"] !== undefined ? obj(body["region"]) : null;
  let rect: Rect | undefined;
  if (region) {
    const x = num(region["x"]);
    const y = num(region["y"]);
    const width = num(region["width"]);
    const height = num(region["height"]);
    if (x === undefined || y === undefined || width === undefined || height === undefined || width <= 0 || height <= 0) throw new BridgeError(400, "region needs numeric x, y, width > 0, height > 0");
    rect = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  }
  const scale = num(body["scale"]) ?? 1;
  if (scale < 0.1 || scale > 1) throw new BridgeError(400, "scale must be within 0.1–1");
  const format = str(body["format"]) ?? "png";
  if (format !== "png" && format !== "jpeg") throw new BridgeError(400, "format must be png or jpeg");
  let image = await win.capture(rect);
  const size = image.size();
  if (size.width === 0 || size.height === 0) throw new BridgeError(503, "window produced an empty capture (hidden or not painted yet)");
  if (scale < 1) image = image.resize(Math.max(1, Math.round(size.width * scale)), Math.max(1, Math.round(size.height * scale)));
  const out = image.size();
  const buf = format === "png" ? image.png() : image.jpeg(JPEG_QUALITY);
  return { mime: format === "png" ? "image/png" : "image/jpeg", base64: buf.toString("base64"), width: out.width, height: out.height, windowId: win.id };
}

async function click(win: AutomationWindow, body: Record<string, unknown>) {
  const button = (str(body["button"]) ?? "left") as MouseButton;
  if (!["left", "right", "middle"].includes(button)) throw new BridgeError(400, "button must be left, right or middle");
  const clickCount = Math.min(3, Math.max(1, Math.round(num(body["clickCount"]) ?? 1)));
  const selector = str(body["selector"]);
  let x = num(body["x"]);
  let y = num(body["y"]);
  let extra: Record<string, unknown> = {};
  if (selector) {
    const target = await evalInWindow(win, CLICK_TARGET_JS(selector));
    if (!target.ok) throw new BridgeError(400, `bad selector: ${target.error}`);
    const t = target.value as { handled: boolean; error?: string; tag?: string; value?: string; x?: number; y?: number; width?: number; height?: number } | null;
    if (!t) throw new BridgeError(404, `no element matches ${selector}`);
    if (t.error) throw new BridgeError(400, t.error);
    if (t.handled) return { selector, synthetic: true, tag: t.tag, value: t.value, x: null, y: null };
    x = t.x;
    y = t.y;
    extra = { tag: t.tag, width: t.width, height: t.height };
  }
  if (x === undefined || y === undefined) throw new BridgeError(400, "pass selector or x and y");
  const px = Math.round(x);
  const py = Math.round(y);
  win.focus();
  win.sendInputEvent({ type: "mouseMove", x: px, y: py });
  for (let i = 1; i <= clickCount; i++) {
    win.sendInputEvent({ type: "mouseDown", x: px, y: py, button, clickCount: i });
    win.sendInputEvent({ type: "mouseUp", x: px, y: py, button, clickCount: i });
  }
  return { ...(selector ? { selector } : {}), x: px, y: py, button, clickCount, synthetic: false, ...extra };
}

export function keyEventsFor(keyCode: string, modifiers: string[]): InputEvent[] {
  const printable = keyCode.length === 1 && !modifiers.some((m) => m === "control" || m === "meta" || m === "alt");
  const mods = modifiers.length ? { modifiers } : {};
  return [
    { type: "keyDown", keyCode, ...mods },
    ...(printable ? [{ type: "char", keyCode, ...mods } as InputEvent] : []),
    { type: "keyUp", keyCode, ...mods },
  ];
}

/** Text → key events: characters as keyDown/char/keyUp, "\n" as Shift+Return, "\t" as Tab. */
export function typeEventsFor(text: string): InputEvent[] {
  const events: InputEvent[] = [];
  for (const ch of text) {
    if (ch === "\n") events.push(...keyEventsFor("Return", ["shift"]), { type: "char", keyCode: "Return", modifiers: ["shift"] });
    else if (ch === "\r") continue;
    else if (ch === "\t") events.push(...keyEventsFor("Tab", []));
    else events.push({ type: "keyDown", keyCode: ch }, { type: "char", keyCode: ch }, { type: "keyUp", keyCode: ch });
  }
  return events;
}

async function type(win: AutomationWindow, body: Record<string, unknown>) {
  const text = str(body["text"]);
  if (!text) throw new BridgeError(400, "text is required");
  const selector = str(body["selector"]);
  let focused: unknown = null;
  if (selector) {
    const res = await evalInWindow(win, FOCUS_JS(selector));
    if (!res.ok) throw new BridgeError(400, `bad selector: ${res.error}`);
    if (res.value === null) throw new BridgeError(404, `no element matches ${selector}`);
    focused = res.value;
  }
  win.focus();
  const events = typeEventsFor(text);
  let n = 0;
  for (const ev of events) {
    win.sendInputEvent(ev);
    if (++n % 60 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  return { typed: [...text].length, events: events.length, ...(selector ? { selector, focused } : {}) };
}

async function key(win: AutomationWindow, body: Record<string, unknown>, platform: NodeJS.Platform) {
  const k = str(body["key"]);
  if (!k) throw new BridgeError(400, "key is required");
  const parsed = parseAccelerator(k, platform);
  const extraMods = Array.isArray(body["modifiers"]) ? (body["modifiers"] as unknown[]).filter((m): m is string => typeof m === "string") : [];
  const modifiers = [...parsed.modifiers];
  for (const m of extraMods) {
    const mod = MODIFIER_NAMES[m.toLowerCase()];
    const name = typeof mod === "function" ? mod(platform) : mod;
    if (name && !modifiers.includes(name)) modifiers.push(name);
  }
  win.focus();
  const events = keyEventsFor(parsed.keyCode, modifiers);
  for (const ev of events) win.sendInputEvent(ev);
  return { key: k, keyCode: parsed.keyCode, modifiers };
}

export const WAIT_POLL_MS = 100;
export const MAX_WAIT_MS = 120_000;

/**
 * `waitFor(predicate, timeoutMs)`: the page's CSP forbids `new Function`, so the predicate is
 * compiled here and evaluated through executeJavaScript on every poll. `state` is the renderer
 * snapshot, `app` the automation API, `document` the page.
 */
export async function waitFor(win: AutomationWindow, args: unknown[]): Promise<{ ok: boolean; value?: unknown; elapsedMs: number; error?: string }> {
  const predicate = typeof args[0] === "string" ? args[0].trim() : "";
  if (!predicate) throw new BridgeError(400, "waitFor needs a predicate expression");
  if (predicate.length > 4000) throw new BridgeError(400, "predicate too long");
  const timeoutMs = Math.min(MAX_WAIT_MS, Math.max(100, num(args[1]) ?? 10_000));
  const probe = `(() => { const app = window.__fabdeskApp; if (!app) throw new Error("__NO_API__"); const state = app.state(); return (\n${predicate}\n); })()`;
  const started = Date.now();
  let lastError: string | undefined;
  while (true) {
    const res = await evalInWindow(win, probe, Math.min(EVAL_TIMEOUT_MS, timeoutMs));
    if (res.ok) {
      if (res.value) return { ok: true, value: res.value, elapsedMs: Date.now() - started };
      lastError = undefined;
    } else {
      if (res.error.includes("__NO_API__")) throw new BridgeError(503, "renderer automation API not installed");
      lastError = res.error.split("\n")[0];
    }
    const elapsed = Date.now() - started;
    if (elapsed >= timeoutMs) return { ok: false, elapsedMs: elapsed, ...(lastError ? { error: lastError } : {}) };
    await new Promise((r) => setTimeout(r, Math.min(WAIT_POLL_MS, timeoutMs - elapsed)));
  }
}

export async function handleBridgeRequest(req: BridgeRequest, deps: AutomationDeps): Promise<BridgeResponse> {
  const body = obj(req.body);
  const windowId = num(body["windowId"]) ?? num(req.query.get("windowId"));
  const route = `${req.method.toUpperCase()} ${req.path}`;
  switch (route) {
    case "GET /state": {
      const windows = deps.windows().filter((w) => !w.isDestroyed());
      let ui: unknown = null;
      let uiError: string | undefined;
      const win = windows.find((w) => w.isFocused()) ?? windows[0];
      if (win) {
        try {
          ui = await rendererApi(win, "window.__fabdeskApp.state()");
        } catch (e) {
          uiError = e instanceof Error ? e.message : String(e);
        }
      }
      return {
        status: 200,
        body: {
          ok: true,
          app: { version: deps.version, packaged: deps.packaged, platform: deps.platform, mode: deps.mode, pid: deps.pid },
          windows: windows.map(windowInfo),
          ui,
          ...(uiError ? { uiError } : {}),
        },
      };
    }
    case "POST /screenshot":
      return { status: 200, body: await screenshot(chooseWindow(deps.windows(), windowId), body) };
    case "POST /eval": {
      const code = str(body["code"]);
      if (!code) throw new BridgeError(400, "code is required");
      const timeoutMs = Math.min(EVAL_TIMEOUT_MS, Math.max(100, num(body["timeoutMs"]) ?? EVAL_TIMEOUT_MS));
      const res = await evalInWindow(chooseWindow(deps.windows(), windowId), code, timeoutMs);
      if (!res.ok) return { status: 422, body: { error: res.error } };
      return { status: 200, body: { result: res.value } };
    }
    case "POST /click":
      return { status: 200, body: await click(chooseWindow(deps.windows(), windowId), body) };
    case "POST /type":
      return { status: 200, body: await type(chooseWindow(deps.windows(), windowId), body) };
    case "POST /key":
      return { status: 200, body: await key(chooseWindow(deps.windows(), windowId), body, deps.platform) };
    case "POST /ui": {
      const action = str(body["action"]);
      if (!action || !/^[a-zA-Z_][\w.]*$/.test(action)) throw new BridgeError(400, "action must be a dotted identifier, e.g. openTab or cinema.setView");
      const args = Array.isArray(body["args"]) ? body["args"] : [];
      const win = chooseWindow(deps.windows(), windowId);
      if (action === "waitFor") return { status: 200, body: { result: await waitFor(win, args) } };
      // A timeout here must not be mistaken for "nothing happened": the action keeps running in the page
      // (a send that took long still sends), so the caller is told not to retry blindly.
      const result = await rendererApi(win, `window.__fabdeskApp.__invoke(${JSON.stringify(action)}, ${JSON.stringify(args)})`, UI_ACTION_TIMEOUT_MS).catch((e: unknown) => {
        if (e instanceof BridgeError && /timed out/.test(e.message)) throw new BridgeError(504, `${e.message}; the ${action} action may still have completed in the app, check app_state before retrying`);
        throw e;
      });
      return { status: 200, body: { result } };
    }
    case "GET /find": {
      const query = req.query.get("query")?.trim();
      if (!query) throw new BridgeError(400, "query is required");
      const limit = Math.min(50, Math.max(1, num(req.query.get("limit")) ?? 10));
      const matches = await rendererApi(chooseWindow(deps.windows(), windowId), `window.__fabdeskApp.find(${JSON.stringify(query)}, ${limit})`);
      return { status: 200, body: { query, matches } };
    }
    default:
      throw new BridgeError(404, `unknown route ${route}`);
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > MAX_BODY_BYTES) throw new BridgeError(413, "body too large");
    chunks.push(b);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new BridgeError(400, "body must be JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload), "cache-control": "no-store" });
  res.end(payload);
}

export type BridgeServer = { url: string; port: number; close(): Promise<void>; server: Server };

/** Bind on 127.0.0.1 at a random port. */
export function startBridgeServer(deps: AutomationDeps, opts: { host?: string; port?: number; log?: (line: string) => void } = {}): Promise<BridgeServer> {
  const host = opts.host ?? "127.0.0.1";
  const server = createServer(async (req, res) => {
    try {
      if (!isLoopbackAddress(req.socket.remoteAddress)) return send(res, 403, { error: "loopback only" });
      const origin = req.headers.origin;
      if (!originAllowed(typeof origin === "string" ? origin : null)) return send(res, 403, { error: "foreign origin" });
      if (!authorized(req.headers.authorization, deps.token())) return send(res, 401, { error: "unauthorized" });
      const url = new URL(req.url ?? "/", `http://${host}`);
      const method = (req.method ?? "GET").toUpperCase();
      const body = method === "POST" ? await readBody(req) : undefined;
      const out = await handleBridgeRequest({ method, path: url.pathname, query: url.searchParams, body }, deps);
      send(res, out.status, out.body);
    } catch (e) {
      if (e instanceof BridgeError) return send(res, e.status, { error: e.message });
      const msg = e instanceof Error ? e.message : String(e);
      opts.log?.(`bridge error: ${msg}`);
      send(res, 500, { error: msg });
    }
  });
  server.keepAliveTimeout = 5_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://${host}:${port}`,
        port,
        server,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}
