/**
 * Renderer automation API: `window.__fabdeskApp`, driven by the Electron main bridge
 * (src/main/automation-server.ts) for the core's `app` toolset. Only installed when the preload
 * reports `automationEnabled` (dev builds / FABDESK_AUTOMATION=1); see docs/app-automation.md.
 *
 * Everything here goes through the same zustand stores and composer handlers the UI uses, so the
 * real code paths run (thread creation, agent runs, cinema playback).
 */
import { capturePanelContext, BOARD_TABS, newChatDraftKey, composerHandlers, useAuthStore, useCinemaStore, useUiStore, type BoardTab } from "@fabdesk/ui";
import { cssPath, implicitRole, normalizeText, rankMatches, uiSnapshot, type ElementInfo, type PathNode, type RankedElement, type UiSnapshot } from "./automation-core";

const SETTINGS_SECTIONS = ["agents", "kicad", "router", "auth", "remote", "voice", "appearance", "privacy", "shortcuts"] as const;
type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

const CANDIDATE_SELECTOR = 'a[href],button,input,select,textarea,option,summary,[role],[tabindex],[data-testid],[aria-label],label,h1,h2,h3';

// An occluded or backgrounded window never paints, so a bare requestAnimationFrame would hang every
// action until the user brings the app forward; the timer keeps automation moving in that case.
const nextFrame = () =>
  new Promise<void>((r) => {
    const t = setTimeout(r, 50);
    requestAnimationFrame(() => {
      clearTimeout(t);
      r();
    });
  });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Let React commit store updates (two frames plus a macrotask). */
async function settle(): Promise<void> {
  await nextFrame();
  await nextFrame();
  await sleep(0);
}

function runtime() {
  return window.__fabdeskRuntime ?? { client: null, coreInfo: null };
}

function state() {
  const core = runtime().coreInfo;
  return { ...uiSnapshot({
    ui: useUiStore.getState(),
    cinema: useCinemaStore.getState(),
    auth: useAuthStore.getState().state,
    core: core ? { url: core.url, status: core.status } : null,
    page: { href: location.href, title: document.title, width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio, composerMounted: composerHandlers.send !== null },
    newChatDraftKey: newChatDraftKey(useUiStore.getState().activeProjectId),
  }), panelContext: capturePanelContext() };
}

function pathNode(el: Element): PathNode {
  const tag = el.tagName.toLowerCase();
  const parent = el.parentElement;
  let nthOfType = 1;
  let countOfType = 1;
  if (parent) {
    const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
    countOfType = same.length;
    nthOfType = same.indexOf(el) + 1;
  }
  return {
    tag,
    id: el.id || null,
    testid: el.getAttribute("data-testid"),
    parent: parent ? pathNode(parent) : null,
    nthOfType,
    countOfType,
  };
}

const isUnique = (selector: string): boolean => {
  try {
    return document.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
};

function labelFor(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria) return aria;
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .filter(Boolean);
    if (parts.length) return parts.join(" ");
  }
  const title = el.getAttribute("title");
  if (title) return title;
  const placeholder = el.getAttribute("placeholder");
  if (placeholder) return placeholder;
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
    const labels = el.labels ? Array.from(el.labels).map((l) => l.textContent ?? "") : [];
    if (labels.length) return labels.join(" ");
    if (el instanceof HTMLInputElement && (el.type === "button" || el.type === "submit")) return el.value;
  }
  if (el instanceof HTMLImageElement) return el.alt;
  if (el instanceof HTMLOptionElement) return el.label || el.text;
  return "";
}

function boundsOf(el: Element): { x: number; y: number; width: number; height: number } {
  const target = el instanceof HTMLOptionElement ? (el.closest("select") ?? el) : el;
  const r = target.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function describe(el: Element): ElementInfo | null {
  const bounds = boundsOf(el);
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute("role") ?? implicitRole(tag, el instanceof HTMLInputElement ? el.type : null);
  let text: string;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) text = normalizeText(el.value);
  else if (el instanceof HTMLSelectElement) text = normalizeText(el.selectedOptions[0]?.text ?? "");
  else text = normalizeText((el as HTMLElement).innerText ?? el.textContent);
  const disabled = (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true";
  return { ref: cssPath(pathNode(el), isUnique), role, name: normalizeText(labelFor(el)), text, testid: el.getAttribute("data-testid"), bounds, disabled };
}

function find(query: string, limit = 10): RankedElement[] {
  const seen = new Set<Element>();
  const infos: ElementInfo[] = [];
  for (const el of Array.from(document.querySelectorAll(CANDIDATE_SELECTOR))) {
    if (seen.has(el)) continue;
    seen.add(el);
    const info = describe(el);
    if (info) infos.push(info);
  }
  return rankMatches(infos, query, limit);
}

async function selectProject(idOrName: string): Promise<{ projectId: string; name: string | null } & UiSnapshot> {
  let id = idOrName;
  let name: string | null = null;
  const client = runtime().client;
  if (client) {
    const list = await client.listProjects();
    const lower = idOrName.toLowerCase();
    const hit = list.find((p) => p.id === idOrName) ?? list.find((p) => p.name === idOrName || p.path === idOrName) ?? list.find((p) => p.name.toLowerCase() === lower);
    if (!hit) throw new Error(`project not found: ${idOrName} (known: ${list.map((p) => `${p.name} [${p.id}]`).join(", ") || "none"})`);
    id = hit.id;
    name = hit.name;
  }
  useUiStore.getState().setActiveProject(id);
  await settle();
  return { projectId: id, name, ...state() };
}

async function openTab(tab: string): Promise<UiSnapshot> {
  if (!(BOARD_TABS as readonly string[]).includes(tab)) throw new Error(`unknown board tab "${tab}" (expected ${BOARD_TABS.join(", ")})`);
  useUiStore.getState().setBoardTab(tab as BoardTab);
  await settle();
  return state();
}

async function openThread(id: string): Promise<UiSnapshot> {
  if (!id) throw new Error("thread id is required");
  useUiStore.getState().setActiveThread(id);
  await settle();
  return state();
}

async function newChat(): Promise<UiSnapshot> {
  const ui = useUiStore.getState();
  // Match the sidebar/shortcut: cancelling project selection keeps the current chat.
  ui.setProjectPickerOpen(true);
  await settle();
  return state();
}

function draftKey(): string {
  const ui = useUiStore.getState();
  return ui.activeThreadId ?? newChatDraftKey(ui.activeProjectId);
}

async function setComposer(text: string): Promise<{ draftKey: string; draft: string }> {
  const key = draftKey();
  useUiStore.getState().setDraft(key, text);
  await settle();
  return { draftKey: key, draft: useUiStore.getState().drafts[key] ?? "" };
}

/**
 * The composer's agent picker is a React dropdown, not a native <select>, so drive the same state
 * the menu writes through the composer bridge instead of clicking the DOM.
 */
function setAgent(agentId: string): boolean {
  return composerHandlers.setAgent?.(agentId) ?? false;
}

async function send(): Promise<{ sent: boolean; reason?: string; threadId: string | null; elapsedMs: number }> {
  const started = performance.now();
  const key = draftKey();
  const draft = (useUiStore.getState().drafts[key] ?? "").trim();
  if (!draft) return { sent: false, reason: "composer is empty (call setComposer first)", threadId: useUiStore.getState().activeThreadId, elapsedMs: 0 };
  if (!composerHandlers.send) return { sent: false, reason: "composer is not mounted (core not ready or no chat view)", threadId: useUiStore.getState().activeThreadId, elapsedMs: 0 };
  composerHandlers.send();
  // The composer clears the draft after the message is accepted by the core.
  const deadline = started + 20_000;
  while (performance.now() < deadline) {
    await sleep(50);
    const s = useUiStore.getState();
    const current = s.drafts[key] ?? "";
    if (current.trim() === "") return { sent: true, threadId: s.activeThreadId, elapsedMs: Math.round(performance.now() - started) };
  }
  return { sent: false, reason: "composer still holds the draft after 20 s (send failed or an agent run is in progress)", threadId: useUiStore.getState().activeThreadId, elapsedMs: Math.round(performance.now() - started) };
}

async function sendMessage(text: string, agent?: string | null) {
  if (agent) {
    const ok = setAgent(agent);
    if (!ok) return { sent: false, reason: `agent "${agent}" is not offered by the composer`, threadId: useUiStore.getState().activeThreadId, elapsedMs: 0 };
    await settle();
  }
  await setComposer(text);
  const res = await send();
  return { ...res, agent: agent ?? null };
}

async function openSettings(section?: string): Promise<UiSnapshot> {
  if (section !== undefined && !(SETTINGS_SECTIONS as readonly string[]).includes(section)) throw new Error(`unknown settings section "${section}" (expected ${SETTINGS_SECTIONS.join(", ")})`);
  useUiStore.getState().setSettingsOpen(true, section as SettingsSection | undefined);
  await settle();
  return state();
}

const cinema = {
  async setView(mode: string) {
    if (mode !== "board" && mode !== "activity") throw new Error(`view mode must be board or activity, got "${mode}"`);
    useUiStore.getState().setBoardTab("cinema");
    useCinemaStore.getState().setViewMode(mode);
    await settle();
    return state().cinema;
  },
  async seek(index: number) {
    if (!Number.isInteger(index) || index < 0) throw new Error("seek index must be a non-negative integer");
    useUiStore.getState().setBoardTab("cinema");
    useCinemaStore.getState().seek(index);
    await settle();
    return state().cinema;
  },
  async goLive() {
    useUiStore.getState().setBoardTab("cinema");
    useCinemaStore.getState().goLive();
    await settle();
    return state().cinema;
  },
  async toggleLayer(layer: number) {
    if (!Number.isInteger(layer) || layer < 0) throw new Error("layer must be a non-negative integer");
    useUiStore.getState().setBoardTab("cinema");
    useCinemaStore.getState().toggleLayer(layer);
    await settle();
    return state().cinema;
  },
  /** Show a persisted run (frames from GET /route/runs/:id/frames), like reopening the tab mid-run. */
  async load(runId: string) {
    if (!runId) throw new Error("run id is required");
    const client = runtime().client;
    if (!client) throw new Error("core client not ready");
    const lines = await client.routeFrames(runId, 0);
    if (lines.length === 0) throw new Error(`run ${runId} has no frames (unknown run id?)`);
    const store = useCinemaStore.getState();
    store.ingestMany(runId, lines);
    store.setActiveRun(runId);
    useUiStore.getState().setBoardTab("cinema");
    await settle();
    return state().cinema;
  },
};

/**
 * In-page variant for scripts that already run in the renderer. String predicates cannot be
 * compiled here (CSP forbids eval); the bridge evaluates those itself (POST /ui waitFor).
 */
async function waitFor(predicate: ((state: UiSnapshot, document: Document, app: unknown) => unknown) | string, timeoutMs = 10_000): Promise<{ ok: boolean; value?: unknown; elapsedMs: number; error?: string }> {
  if (typeof predicate !== "function") throw new Error("waitFor needs a function in the page; string predicates are evaluated by the automation bridge (app_wait_for)");
  const fn = predicate;
  const started = performance.now();
  let lastError: string | undefined;
  while (true) {
    try {
      const v = await fn(state(), document, api);
      if (v) return { ok: true, value: JSON.parse(JSON.stringify(v ?? null)), elapsedMs: Math.round(performance.now() - started) };
      lastError = undefined;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    if (performance.now() - started >= timeoutMs) return { ok: false, elapsedMs: Math.round(performance.now() - started), ...(lastError ? { error: lastError } : {}) };
    await sleep(100);
  }
}

// Track deliberate navigation without introducing another UI control or panel.
let navigationVersion = 0;
const locationKey = (s: ReturnType<typeof useUiStore.getState>) => JSON.stringify([s.activeProjectId, s.activeThreadId, s.workspaceArea, s.boardTab, s.selectedFileByProject[s.activeProjectId ?? ""], s.boardOpen, s.settingsOpen, s.sketchOpen, s.inventoryOpen, s.orderFlowOpen]);
useUiStore.subscribe((next, previous) => { if (locationKey(next) !== locationKey(previous)) navigationVersion++; });
function presentationContext() {
  const s = useUiStore.getState();
  return { projectId: s.activeProjectId, threadId: s.activeThreadId, navigationVersion };
}
async function present(projectId: string, threadId: string | null, path: string, sha256: string, expectedNavigation: number) {
  const active = () => { const s = useUiStore.getState(); return s.activeProjectId === projectId && s.activeThreadId === threadId; };
  if (!active()) return { status: "chat-inactive" };
  if (navigationVersion !== expectedNavigation || document.querySelector('[role="dialog"][aria-modal="true"]')) return { status: "view-held" };
  useUiStore.getState().openProjectFile(path);
  await settle();
  if (!active()) return { status: "superseded" };
  const initial = useUiStore.getState();
  if (initial.boardTab !== "files" || initial.selectedFileByProject[projectId] !== path) return { status: "view-held" };
  const ownNavigation = navigationVersion, deadline = Date.now() + 5000;
  while (true) {
    if (!active()) return { status: "superseded" };
    if (navigationVersion !== ownNavigation) return { status: "view-held" };
    const workspace = capturePanelContext();
    if (workspace.panel.visible && workspace.panel.artifact === path && workspace.panel.status === "ready" && workspace.panel.artifactSha256 === sha256) return { status: "displayed", workspace };
    if (workspace.panel.artifact === path && workspace.panel.status === "error") return { status: "failed", workspace };
    if (Date.now() >= deadline) return { status: "unconfirmed", workspace };
    await sleep(50);
  }
}

const api = {
  version: 1 as const,
  state,
  presentationContext,
  present,
  find,
  selectProject,
  openTab,
  openThread,
  newChat,
  setComposer,
  setAgent,
  send,
  sendMessage,
  openSettings,
  cinema,
  toggleLayer: cinema.toggleLayer,
  waitFor,
  /** Dotted dispatch used by the bridge's POST /ui: `__invoke("cinema.setView", ["board"])`. */
  async __invoke(action: string, args: unknown[] = []): Promise<unknown> {
    let target: unknown = api;
    let parent: unknown = null;
    for (const part of action.split(".")) {
      if (part.startsWith("__") || !target || typeof target !== "object" || !(part in (target as Record<string, unknown>))) throw new Error(`unknown automation action "${action}"`);
      parent = target;
      target = (target as Record<string, unknown>)[part];
    }
    if (typeof target !== "function") throw new Error(`automation action "${action}" is not callable`);
    const result = await (target as (...a: unknown[]) => unknown).apply(parent, args);
    return result === undefined ? null : JSON.parse(JSON.stringify(result));
  },
};

export type FabdeskAutomationApi = typeof api;

export function installAutomation(): FabdeskAutomationApi {
  window.__fabdeskApp = api;
  console.info("[automation] window.__fabdeskApp installed");
  return api;
}
