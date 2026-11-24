/**
 * DOM-free helpers behind the renderer automation API (automation.ts): element matching/ranking,
 * stable CSS paths and the UI state snapshot. Kept pure so they can be unit tested in bun.
 */

export type ElementBounds = { x: number; y: number; width: number; height: number };

export type ElementInfo = {
  /** CSS selector that resolves back to the element (input for app_click / app_type). */
  ref: string;
  role: string;
  name: string;
  text: string;
  testid: string | null;
  bounds: ElementBounds;
  disabled: boolean;
};

export type RankedElement = ElementInfo & { score: number };

const IMPLICIT_ROLES: Record<string, string> = {
  a: "link",
  button: "button",
  select: "combobox",
  textarea: "textbox",
  option: "option",
  summary: "button",
  label: "label",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  img: "img",
  nav: "navigation",
  main: "main",
  dialog: "dialog",
};

const INPUT_ROLES: Record<string, string> = {
  checkbox: "checkbox",
  radio: "radio",
  range: "slider",
  button: "button",
  submit: "button",
  reset: "button",
  file: "button",
  search: "searchbox",
  number: "spinbutton",
};

export function implicitRole(tag: string, inputType?: string | null): string {
  const t = tag.toLowerCase();
  if (t === "input") return INPUT_ROLES[(inputType ?? "text").toLowerCase()] ?? "textbox";
  return IMPLICIT_ROLES[t] ?? "generic";
}

export function normalizeText(s: string | null | undefined, max = 200): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function fieldScore(value: string, q: string, weights: { exact: number; prefix: number; word: number; contains: number }): number {
  const v = value.toLowerCase();
  if (!v) return 0;
  if (v === q) return weights.exact;
  if (v.startsWith(q)) return weights.prefix;
  if (new RegExp(`(^|[^a-z0-9])${escapeRegExp(q)}([^a-z0-9]|$)`).test(v)) return weights.word;
  if (v.includes(q)) return weights.contains;
  return 0;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Relevance of an element for a query, 0 when it does not match. Exact matches on testid/name beat
 * prefix and word matches, which beat plain substrings; shorter texts win ties (more specific).
 */
export function scoreMatch(el: ElementInfo, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const scores = [
    fieldScore(el.testid ?? "", q, { exact: 100, prefix: 80, word: 75, contains: 70 }),
    fieldScore(el.name, q, { exact: 95, prefix: 72, word: 68, contains: 55 }),
    fieldScore(el.text, q, { exact: 90, prefix: 65, word: 60, contains: 40 }),
    fieldScore(el.role, q, { exact: 30, prefix: 0, word: 0, contains: 0 }),
  ];
  const best = Math.max(...scores);
  if (best === 0) return 0;
  const specificity = Math.max(0, 10 - Math.min(10, Math.floor(Math.max(el.name.length, el.text.length) / 20)));
  const interactive = el.role !== "generic" && el.role !== "heading" && el.role !== "label" ? 3 : 0;
  return best + specificity + interactive - (el.disabled ? 5 : 0);
}

export function rankMatches(elements: ElementInfo[], query: string, limit = 10): RankedElement[] {
  const ranked: RankedElement[] = [];
  for (const el of elements) {
    const score = scoreMatch(el, query);
    if (score > 0) ranked.push({ ...el, score });
  }
  ranked.sort((a, b) => b.score - a.score || a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
  return ranked.slice(0, Math.max(1, limit));
}

/** Minimal tree view of an element for building CSS paths. */
export interface PathNode {
  tag: string;
  id: string | null;
  testid: string | null;
  parent: PathNode | null;
  /** 1-based index among siblings with the same tag. */
  nthOfType: number;
  /** Number of siblings (incl. self) with the same tag. */
  countOfType: number;
}

const ID_RE = /^[A-Za-z_][\w-]*$/;

export function cssEscape(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}

/**
 * Stable selector: `[data-testid=…]` or `#id` when unique, otherwise a `tag:nth-of-type(n)` path
 * anchored at the nearest unique testid/id ancestor (or the root).
 */
export function cssPath(node: PathNode, isUnique: (selector: string) => boolean): string {
  const segments: string[] = [];
  let cur: PathNode | null = node;
  while (cur) {
    const anchor = anchorFor(cur, isUnique);
    if (anchor) {
      segments.unshift(anchor);
      break;
    }
    if (cur.tag === "html" || cur.tag === "body") {
      if (cur.tag === "body") segments.unshift("body");
      break;
    }
    segments.unshift(cur.countOfType > 1 ? `${cur.tag}:nth-of-type(${cur.nthOfType})` : cur.tag);
    cur = cur.parent;
  }
  return segments.join(" > ");
}

function anchorFor(node: PathNode, isUnique: (selector: string) => boolean): string | null {
  if (node.testid) {
    const sel = `[data-testid="${cssEscape(node.testid)}"]`;
    if (isUnique(sel)) return sel;
  }
  if (node.id && ID_RE.test(node.id)) {
    const sel = `#${node.id}`;
    if (isUnique(sel)) return sel;
  }
  return null;
}

/** Store snapshots the UI state is built from (structural so tests need no zustand). */
export type UiSnapshotInput = {
  ui: {
    sidebarOpen: boolean;
    boardOpen: boolean;
    activeThreadId: string | null;
    activeProjectId: string | null;
    boardTab: string;
    drafts: Record<string, string>;
    paletteOpen: boolean;
    settingsOpen: boolean;
    settingsSection: string | null;
    sketchOpen: boolean;
    markupOpen?: boolean;
    agentPickerOpen: boolean;
  };
  cinema: {
    runs: Record<string, { frames: unknown[]; evicted?: number; result?: { complete: unknown[]; open: unknown[]; timedOut?: boolean } | undefined }>;
    activeRunId: string | null;
    cursor: number;
    playing: boolean;
    followLive: boolean;
    hiddenLayers: number[];
    playbackMs: number;
    viewMode: string;
    perf: { fps: number; drawMs: number; received: number; dropped: number };
  };
  auth: unknown;
  core: { url: string | null; status: unknown } | null;
  page: { href: string; title: string; width: number; height: number; dpr: number; composerMounted: boolean };
  newChatDraftKey: string;
};

export function uiSnapshot(input: UiSnapshotInput) {
  const { ui, cinema } = input;
  const run = cinema.activeRunId ? cinema.runs[cinema.activeRunId] : undefined;
  const draftKey = ui.activeThreadId ?? input.newChatDraftKey;
  return {
    activeProjectId: ui.activeProjectId,
    activeThreadId: ui.activeThreadId,
    boardTab: ui.boardTab,
    boardOpen: ui.boardOpen,
    sidebarOpen: ui.sidebarOpen,
    settingsOpen: ui.settingsOpen,
    settingsSection: ui.settingsSection,
    paletteOpen: ui.paletteOpen,
    sketchOpen: ui.sketchOpen,
    markupOpen: ui.markupOpen ?? false,
    agentPickerOpen: ui.agentPickerOpen,
    composer: { draft: ui.drafts[draftKey] ?? "", mounted: input.page.composerMounted },
    cinema: {
      activeRunId: cinema.activeRunId,
      runIds: Object.keys(cinema.runs),
      frames: run?.frames.length ?? 0,
      evicted: run?.evicted ?? 0,
      cursor: cinema.cursor,
      playing: cinema.playing,
      followLive: cinema.followLive,
      viewMode: cinema.viewMode,
      hiddenLayers: [...cinema.hiddenLayers],
      playbackMs: cinema.playbackMs,
      perf: { ...cinema.perf },
      result: run?.result ? { complete: run.result.complete.length, open: run.result.open.length, timedOut: run.result.timedOut ?? false } : null,
    },
    auth: input.auth,
    core: input.core,
    page: { ...input.page },
  };
}

export type UiSnapshot = ReturnType<typeof uiSnapshot>;
