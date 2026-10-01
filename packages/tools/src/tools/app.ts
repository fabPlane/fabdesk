/**
 * App toolset: screenshot and drive the fabPlane desktop window through the loopback automation
 * bridge (Electron main, dev builds or FABDESK_AUTOMATION=1; docs/app-automation.md). Every tool
 * fails with a clear `unavailable` error when no bridge is running.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import { ToolError, defineTool, type ToolContext } from "../registry";
import type { AppBridge } from "../services";
import { ok, table } from "./common";

export const APP_BOARD_TABS = [
  "schematic",
  "pcb",
  "cinema",
  "3d",
  "cad",
  "drc",
  "renders",
  "files",
  "bom",
] as const;
export const APP_SETTINGS_SECTIONS = [
  "agents",
  "kicad",
  "router",
  "auth",
  "appearance",
  "privacy",
  "shortcuts",
] as const;

export const NO_BRIDGE_MESSAGE =
  "The fabPlane desktop app automation bridge is not running. Start the app in dev mode (`bun run dev` in apps/desktop) or launch a packaged build with FABDESK_AUTOMATION=1; the bridge writes app-bridge.json next to daemon.json. See docs/app-automation.md.";

export function requireBridge(ctx: ToolContext): AppBridge {
  const bridge = ctx.services.appBridge;
  if (!bridge) throw new ToolError(NO_BRIDGE_MESSAGE, "unavailable");
  return bridge;
}

/** Shape of the renderer `find()` results (mirrors apps/desktop/src/renderer/automation-core.ts). */
export type AppElementMatch = {
  ref: string;
  role: string;
  name: string;
  text: string;
  testid: string | null;
  bounds: { x: number; y: number; width: number; height: number };
  disabled: boolean;
  score?: number;
};

type ScreenshotResponse = {
  mime: string;
  base64: string;
  width: number;
  height: number;
  windowId: number;
};
type UiResponse<T = unknown> = { result: T };

async function ui<T = unknown>(
  ctx: ToolContext,
  action: string,
  args: unknown[] = [],
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const res = await requireBridge(ctx).call<UiResponse<T>>("POST", "/ui", { action, args }, opts);
  return res.result;
}

function summarizeState(state: Record<string, unknown>): string {
  const app = (state["app"] ?? {}) as Record<string, unknown>;
  const windows = (state["windows"] ?? []) as Array<Record<string, unknown>>;
  const u = state["ui"] as Record<string, unknown> | null | undefined;
  const lines = [
    `fabPlane ${app["version"] ?? "?"} (${app["packaged"] ? "packaged" : "dev"}, automation ${app["mode"] ?? "?"}); ${windows.length} window(s)`,
  ];
  for (const w of windows) {
    const b = (w["bounds"] ?? {}) as Record<string, number>;
    lines.push(
      `- window ${w["id"]}${w["focused"] ? " (focused)" : ""}: ${b["width"]}×${b["height"]} at (${b["x"]}, ${b["y"]}) ${w["url"] ?? ""}`,
    );
  }
  if (!u) {
    lines.push(
      "Renderer UI snapshot unavailable (window still loading or automation API not installed).",
    );
    return lines.join("\n");
  }
  const cinema = (u["cinema"] ?? {}) as Record<string, unknown>;
  const core = (u["core"] ?? {}) as Record<string, unknown>;
  lines.push(
    `UI: project=${u["activeProjectId"] ?? "none"} thread=${u["activeThreadId"] ?? "new chat"} boardTab=${u["boardTab"]} boardOpen=${u["boardOpen"]} sidebarOpen=${u["sidebarOpen"]} settingsOpen=${u["settingsOpen"]} paletteOpen=${u["paletteOpen"]}`,
    `Cinema: run=${cinema["activeRunId"] ?? "none"} frames=${cinema["frames"] ?? 0} cursor=${cinema["cursor"] ?? -1} view=${cinema["viewMode"] ?? "?"} live=${cinema["followLive"] ?? "?"} hiddenLayers=${JSON.stringify(cinema["hiddenLayers"] ?? [])}`,
    `Auth: ${JSON.stringify(u["auth"] ?? null)}; core: ${core["url"] ?? "?"} (${(core["status"] as Record<string, unknown> | undefined)?.["state"] ?? "?"})`,
  );
  return lines.join("\n");
}

export const app_state = defineTool({
  name: "app_state",
  toolset: "app",
  scope: "global",
  title: "Desktop app state",
  description:
    "Return the running fabPlane desktop app version, windows, and renderer UI state. Fails with `unavailable` when no app bridge is running.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (_args, ctx) => {
    const state = await requireBridge(ctx).call<Record<string, unknown>>("GET", "/state");
    return ok(summarizeState(state), state);
  },
});

export const app_screenshot = defineTool({
  name: "app_screenshot",
  toolset: "app",
  scope: "global",
  title: "Screenshot the app window",
  description:
    "Capture the fabPlane desktop window or a CSS-pixel region and return image content. Defaults are scale 0.5 and JPEG for full windows, PNG for regions.",
  inputSchema: {
    windowId: z
      .number()
      .int()
      .optional()
      .describe("Window id from app_state; default focused/first window"),
    region: z
      .object({
        x: z.number(),
        y: z.number(),
        width: z.number().positive(),
        height: z.number().positive(),
      })
      .optional()
      .describe("Crop to this rectangle (CSS px, top-left origin of the page)"),
    scale: z
      .number()
      .min(0.1)
      .max(1)
      .optional()
      .describe("Downscale factor; default 0.5 for full window, 1 for regions"),
    format: z
      .enum(["png", "jpeg"])
      .optional()
      .describe("Image format; default jpeg for full window, png for regions"),
    annotate: z.boolean().optional().describe("Reserved: overlay element refs (currently a no-op)"),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async ({ windowId, region, scale, format }, ctx) => {
    const fmt = format ?? (region ? "png" : "jpeg");
    const body = {
      ...(windowId !== undefined ? { windowId } : {}),
      ...(region ? { region } : {}),
      scale: scale ?? (region ? 1 : 0.5),
      format: fmt,
    };
    const shot = await requireBridge(ctx).call<ScreenshotResponse>("POST", "/screenshot", body);
    const dir = join(tmpdir(), "fabdesk-app-shots");
    await mkdir(dir, { recursive: true });
    const path = join(
      dir,
      `shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${fmt === "png" ? "png" : "jpg"}`,
    );
    await writeFile(path, Buffer.from(shot.base64, "base64"));
    return ok(
      `Captured window ${shot.windowId}: ${shot.width}×${shot.height} ${shot.mime}${region ? ` (region ${region.width}×${region.height} at ${region.x},${region.y})` : ""}, scale ${body.scale}. Saved to ${path}.`,
      {
        path,
        mime: shot.mime,
        width: shot.width,
        height: shot.height,
        windowId: shot.windowId,
        scale: body.scale,
      },
      { images: [{ path, mime: shot.mime }] },
    );
  },
});

export const app_find = defineTool({
  name: "app_find",
  toolset: "app",
  scope: "global",
  title: "Find UI elements",
  description:
    'Search the app window for interactive or labelled elements (buttons, links, inputs, selects and their options, tabs, anything with a role, aria-label or data-testid) whose role, name, text or testid contains the query (case-insensitive; best matches first). Returns a `ref` per match: a stable CSS selector you pass to app_click {selector} or app_type {selector}. Example: app_find "Route Cinema" → click the tab; app_find "whole board" → pick a select option.',
  inputSchema: {
    query: z.string().min(1).describe("Text to look for in role, name, text or data-testid"),
    limit: z.number().int().min(1).max(50).default(10),
    windowId: z.number().int().optional(),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async ({ query, limit, windowId }, ctx) => {
    const qs = new URLSearchParams({
      query,
      limit: String(limit),
      ...(windowId !== undefined ? { windowId: String(windowId) } : {}),
    });
    const res = await requireBridge(ctx).call<{ matches: AppElementMatch[] }>(
      "GET",
      `/find?${qs.toString()}`,
    );
    const matches = res.matches ?? [];
    if (matches.length === 0)
      return ok(
        `No elements match "${query}". Try a shorter query or app_screenshot to see the window.`,
        { query, matches },
      );
    const rows = matches.map((m) => ({
      ref: m.ref,
      role: m.role,
      name: m.name,
      text: m.text.length > 60 ? `${m.text.slice(0, 57)}…` : m.text,
      testid: m.testid ?? "",
      at: `${Math.round(m.bounds.x)},${Math.round(m.bounds.y)} ${Math.round(m.bounds.width)}×${Math.round(m.bounds.height)}`,
      disabled: m.disabled ? "yes" : "",
    }));
    return ok(
      `${matches.length} match(es) for "${query}" (pass ref as app_click.selector):\n${table(rows, ["ref", "role", "name", "text", "testid", "at", "disabled"])}`,
      { query, matches },
    );
  },
});

export const app_click = defineTool({
  name: "app_click",
  toolset: "app",
  scope: "global",
  title: "Click in the app",
  description:
    "Click an element by CSS selector or at CSS-pixel window coordinates. Selector clicks scroll the element into view and send mouse events at its centre; clicking an <option> selects it in its <select>.",
  inputSchema: {
    selector: z.string().min(1).optional().describe("CSS selector / ref from app_find"),
    x: z.number().optional().describe("CSS px from the left edge of the page (when no selector)"),
    y: z.number().optional().describe("CSS px from the top edge of the page (when no selector)"),
    button: z.enum(["left", "right", "middle"]).default("left"),
    clickCount: z.number().int().min(1).max(3).default(1).describe("2 for double-click"),
    windowId: z.number().int().optional(),
  },
  annotations: { idempotentHint: false },
  handler: async ({ selector, x, y, button, clickCount, windowId }, ctx) => {
    if (!selector && (x === undefined || y === undefined))
      throw new ToolError("pass `selector` or both `x` and `y`", "invalid_args");
    const res = await requireBridge(ctx).call<Record<string, unknown>>("POST", "/click", {
      ...(selector ? { selector } : { x, y }),
      button,
      clickCount,
      ...(windowId !== undefined ? { windowId } : {}),
    });
    if (res["synthetic"])
      return ok(
        `Selected option ${JSON.stringify(res["value"] ?? "")} via its <select> (${selector}); no mouse events needed.`,
        res,
      );
    const where = selector ? `${selector} at (${res["x"]}, ${res["y"]})` : `(${x}, ${y})`;
    return ok(`Clicked ${where}${clickCount > 1 ? ` ×${clickCount}` : ""}.`, res);
  },
});

export const app_type = defineTool({
  name: "app_type",
  toolset: "app",
  scope: "global",
  title: "Type text in the app",
  description:
    "Type text with key events into the focused element, or focus `selector` first. Newlines are typed as Shift+Enter.",
  inputSchema: {
    text: z.string().min(1).max(20_000),
    selector: z.string().min(1).optional().describe("Focus this element before typing"),
    windowId: z.number().int().optional(),
  },
  annotations: { idempotentHint: false },
  handler: async ({ text, selector, windowId }, ctx) => {
    const res = await requireBridge(ctx).call<Record<string, unknown>>("POST", "/type", {
      text,
      ...(selector ? { selector } : {}),
      ...(windowId !== undefined ? { windowId } : {}),
    });
    return ok(`Typed ${text.length} character(s)${selector ? ` into ${selector}` : ""}.`, res);
  },
});

export const app_key = defineTool({
  name: "app_key",
  toolset: "app",
  scope: "global",
  title: "Press a key",
  description:
    "Send one key press to the app using Electron accelerator syntax, such as `Enter`, `Escape`, `Tab`, `CommandOrControl+K`, `Shift+Enter`, or `ArrowDown`.",
  inputSchema: {
    key: z.string().min(1).describe("Accelerator string, e.g. Enter, Escape, CommandOrControl+K"),
    windowId: z.number().int().optional(),
  },
  annotations: { idempotentHint: false },
  handler: async ({ key, windowId }, ctx) => {
    const res = await requireBridge(ctx).call<Record<string, unknown>>("POST", "/key", {
      key,
      ...(windowId !== undefined ? { windowId } : {}),
    });
    return ok(`Pressed ${key}.`, res);
  },
});

export const app_select_project = defineTool({
  name: "app_select_project",
  toolset: "app",
  scope: "global",
  title: "Select a project in the app",
  description:
    "Make a project the active one in the desktop UI (sidebar filter, board panel, new chats). Accepts a project id, name or path; resolved through the core's project store first. Returns the resulting UI state.",
  inputSchema: {
    project: z.string().min(1).describe("Project id, name or absolute path"),
  },
  annotations: { idempotentHint: true },
  handler: async ({ project }, ctx) => {
    const handle = await ctx.services.projects.resolve(project);
    const result = await ui<Record<string, unknown>>(ctx, "selectProject", [handle?.id ?? project]);
    const resolved = result["projectId"] ?? handle?.id ?? project;
    return ok(`Active project is now ${resolved}${handle ? ` (${handle.name})` : ""}.`, {
      requested: project,
      projectId: resolved,
      resolvedByCore: handle !== null,
      ui: result,
    });
  },
});

export const app_open_tab = defineTool({
  name: "app_open_tab",
  toolset: "app",
  scope: "global",
  title: "Open a board tab",
  description:
    "Open one of the board panel tabs (schematic, pcb, cinema = Route Cinema, 3d, drc, renders, files, bom = Shopping list) and make sure the board panel is visible.",
  inputSchema: {
    tab: z.enum(APP_BOARD_TABS),
  },
  annotations: { idempotentHint: true },
  handler: async ({ tab }, ctx) => {
    const result = await ui<Record<string, unknown>>(ctx, "openTab", [tab]);
    return ok(`Board tab is now ${tab}.`, { tab, ui: result });
  },
});

export const app_open_thread = defineTool({
  name: "app_open_thread",
  toolset: "app",
  scope: "global",
  title: "Open a chat thread",
  description:
    "Show an existing chat thread by id in the desktop UI (as if clicked in the sidebar).",
  inputSchema: {
    thread: z.string().min(1).describe("Thread id"),
  },
  annotations: { idempotentHint: true },
  handler: async ({ thread }, ctx) => {
    const result = await ui<Record<string, unknown>>(ctx, "openThread", [thread]);
    return ok(`Opened thread ${thread}.`, { threadId: thread, ui: result });
  },
});

export const app_new_chat = defineTool({
  name: "app_new_chat",
  toolset: "app",
  scope: "global",
  title: "Start a new chat",
  description:
    "Switch the desktop UI to a fresh, unsaved chat (composer focused) in the active project. The thread is created when the first message is sent.",
  inputSchema: {},
  annotations: { idempotentHint: true },
  handler: async (_args, ctx) => {
    const result = await ui<Record<string, unknown>>(ctx, "newChat", []);
    return ok("New chat opened.", { ui: result });
  },
});

export const app_send_message = defineTool({
  name: "app_send_message",
  toolset: "app",
  scope: "global",
  title: "Send a chat message through the UI",
  description:
    "Put text in the chat composer and send it through the UI. Optionally selects an agent. Returns send status and the resulting thread id.",
  inputSchema: {
    text: z.string().min(1).max(50_000),
    agent: z
      .string()
      .min(1)
      .optional()
      .describe("Agent id to select in the composer before sending (e.g. claude, codex)"),
  },
  annotations: { idempotentHint: false },
  handler: async ({ text, agent }, ctx) => {
    const result = await ui<Record<string, unknown>>(ctx, "sendMessage", [text, agent ?? null]);
    const sent = result["sent"] === true;
    return {
      text: sent
        ? `Message sent${result["threadId"] ? ` in thread ${result["threadId"]}` : ""}${agent ? ` with agent ${agent}` : ""}.`
        : `The composer did not send the message: ${result["reason"] ?? "unknown reason"}.`,
      json: result,
      isError: !sent,
    };
  },
});

export const app_cinema = defineTool({
  name: "app_cinema",
  toolset: "app",
  scope: "global",
  title: "Control Route Cinema",
  description:
    "Control Route Cinema view mode, frame position, live-follow state, visible copper layers, or loaded route run. Returns the cinema state.",
  inputSchema: {
    action: z.enum(["view", "seek", "live", "layer", "load"]),
    mode: z.enum(["board", "activity"]).optional().describe("For action=view"),
    index: z.number().int().min(0).optional().describe("For action=seek: frame index"),
    layer: z.number().int().min(0).optional().describe("For action=layer: copper layer index"),
    run: z.string().min(1).optional().describe("For action=load: route run id"),
  },
  annotations: { idempotentHint: false },
  handler: async ({ action, mode, index, layer, run }, ctx) => {
    let result: Record<string, unknown>;
    switch (action) {
      case "load":
        if (!run) throw new ToolError("action=load needs `run`", "invalid_args");
        result = await ui(ctx, "cinema.load", [run], { timeoutMs: 60_000 });
        break;
      case "view":
        if (!mode) throw new ToolError("action=view needs `mode`", "invalid_args");
        result = await ui(ctx, "cinema.setView", [mode]);
        break;
      case "seek":
        if (index === undefined) throw new ToolError("action=seek needs `index`", "invalid_args");
        result = await ui(ctx, "cinema.seek", [index]);
        break;
      case "live":
        result = await ui(ctx, "cinema.goLive", []);
        break;
      case "layer":
        if (layer === undefined) throw new ToolError("action=layer needs `layer`", "invalid_args");
        result = await ui(ctx, "cinema.toggleLayer", [layer]);
        break;
    }
    return ok(
      `Cinema ${action} done: run=${result["activeRunId"] ?? "none"} frames=${result["frames"] ?? 0} cursor=${result["cursor"] ?? -1} view=${result["viewMode"] ?? "?"} hiddenLayers=${JSON.stringify(result["hiddenLayers"] ?? [])}`,
      result,
    );
  },
});

export const app_wait_for = defineTool({
  name: "app_wait_for",
  toolset: "app",
  scope: "global",
  title: "Wait for a UI condition",
  description:
    "Poll a JavaScript expression in the renderer until it is truthy or the timeout elapses. The expression sees `state` (the app_state UI snapshot: activeProjectId, activeThreadId, boardTab, cinema.frames, ...) and `document`. Examples: `state.boardTab === 'cinema'`, `state.cinema.frames > 10`, `!!document.querySelector('[data-testid=\"production-toggle\"]')`.",
  inputSchema: {
    predicate: z.string().min(1).max(4000).describe("JS expression over `state` and `document`"),
    timeoutMs: z.number().int().min(100).max(120_000).default(10_000),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async ({ predicate, timeoutMs }, ctx) => {
    const result = await ui<{ ok: boolean; value?: unknown; elapsedMs: number; error?: string }>(
      ctx,
      "waitFor",
      [predicate, timeoutMs],
      { timeoutMs: timeoutMs + 10_000 },
    );
    return {
      text: result.ok
        ? `Condition met after ${result.elapsedMs} ms.`
        : `Timed out after ${result.elapsedMs} ms waiting for: ${predicate}${result.error ? ` (last error: ${result.error})` : ""}`,
      json: result,
      isError: !result.ok,
    };
  },
});

/** `app_eval` runs only when the daemon was started with `FABDESK_APP_EVAL=1`. */
export const appEvalEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env["FABDESK_APP_EVAL"] === "1";

export const app_eval = defineTool({
  name: "app_eval",
  toolset: "app",
  scope: "global",
  title: "Evaluate JavaScript in the app",
  description:
    "Run JavaScript in the renderer main world in dev or automation builds and return its JSON-serialisable result. `window.__fabdeskApp` exposes the automation API.",
  inputSchema: {
    code: z
      .string()
      .min(1)
      .max(64_000)
      .describe("Expression or statements (use `return` in statement form); async allowed"),
    timeoutMs: z.number().int().min(100).max(10_000).default(10_000),
    windowId: z.number().int().optional(),
  },
  annotations: { destructiveHint: true, openWorldHint: true, idempotentHint: false },
  handler: async ({ code, timeoutMs, windowId }, ctx) => {
    // Arbitrary JavaScript reaches the host bridge too: an agent once called
    // `window.fabdesk.restartCore()` from here and killed every run, its own included.
    const bridge = requireBridge(ctx);
    if (!appEvalEnabled())
      throw new ToolError(
        "app_eval is off: it can reach the host bridge (restartCore, file dialogs). Set FABDESK_APP_EVAL=1 on the daemon to enable it for a debugging session; use the other app_* tools otherwise.",
        "precondition",
      );
    const res = await bridge.call<{ result: unknown }>("POST", "/eval", {
      code,
      timeoutMs,
      ...(windowId !== undefined ? { windowId } : {}),
    });
    const text = typeof res.result === "string" ? res.result : JSON.stringify(res.result, null, 2);
    return ok(text ?? "null", res);
  },
});

export const appTools = [
  app_state,
  app_screenshot,
  app_find,
  app_click,
  app_type,
  app_key,
  app_select_project,
  app_open_tab,
  app_open_thread,
  app_new_chat,
  app_send_message,
  app_cinema,
  app_wait_for,
  app_eval,
];
