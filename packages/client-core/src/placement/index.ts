import { importBoard, loadSession, clone, issues, spacingGuidelines, netEdges } from "./engine";
import type { PlacementSession, PlacementAnalysis } from "./types";
export * from "./types";
export * from "./editing";
export * from "./recovery";
export {
  saveAutosave,
  decodeAutosave,
  replacementPreview,
  partFromNode,
  parse,
  placementScore,
  sampleArc,
} from "./engine";
export { replaceFootprint } from "./engine";
export {
  clone,
  worldBounds,
  boardContours,
  polygons,
  inside,
  expanded,
  moveParts,
  rotateParts,
  groupParts,
  ungroupParts,
  alignParts,
  spaceParts,
  setAnchor,
  shove,
  relax,
  resizeBoard,
  suggestPlacement,
  reviewPlacement,
  connectedNeighbors,
  nearestClearance,
  exportBoard,
  validatePlacementSettings,
} from "./engine";

export const PLACEMENT_DRAFT_PATH = "placement/draft.placement.json";
export const MAX_PLACEMENT_BYTES = 20 * 1024 * 1024;

/** Both imports and sessions pass the upstream migration and geometry reconstruction boundary. */
export function readPlacement(text: string, filename: string): PlacementSession {
  if (text.length > MAX_PLACEMENT_BYTES)
    throw new Error("This board is larger than 20 MB. Open a smaller board for placement editing.");
  const session = text.trimStart().startsWith("{")
    ? loadSession(text)
    : loadSession(JSON.stringify(importBoard(text, filename)));
  if (session.parts.length > 1500)
    throw new Error("Placement currently supports up to 1,500 parts per board.");
  if (!session.parts.length) throw new Error("This board has no footprints to arrange.");
  if (typeof session.name !== "string")
    throw new Error("The placement session has an invalid name.");
  const ids = new Set<string>();
  for (const p of session.parts) {
    if (typeof p.id !== "string" || ids.has(p.id))
      throw new Error("The session contains duplicate or invalid part IDs.");
    ids.add(p.id);
    if (
      ![p.ref, p.value, p.footprint].every((v) => typeof v === "string") ||
      typeof p.locked !== "boolean"
    )
      throw new Error("The session contains invalid component metadata.");
    if (
      ![
        p.x,
        p.y,
        p.angle,
        p.bounds.minX,
        p.bounds.minY,
        p.bounds.maxX,
        p.bounds.maxY,
        ...p.pads.flatMap((q) => [q.x, q.y, q.w, q.h, q.angle]),
      ].every(Number.isFinite)
    )
      throw new Error("The board contains invalid footprint geometry.");
  }
  return session;
}

export function analyzePlacement(session: PlacementSession): PlacementAnalysis {
  const edges = netEdges(session);
  return {
    findings: issues(session),
    guidelines: spacingGuidelines(session),
    edges,
    length: edges.reduce((n, e) => n + e.length, 0),
  };
}

export interface PlacementHistory {
  past: PlacementSession[];
  present: PlacementSession;
  future: PlacementSession[];
  revision: number;
}
export function placementHistory(session: PlacementSession): PlacementHistory {
  return { past: [], present: clone(session), future: [], revision: 0 };
}
export function commitPlacement(
  history: PlacementHistory,
  next: PlacementSession,
): PlacementHistory {
  // Large native boards carry a full syntax tree. Bound history by size as well as count.
  const limit = Math.max(
    1,
    Math.min(
      60,
      Math.floor((16 * 1024 * 1024) / Math.max(1, JSON.stringify(history.present).length)),
    ),
  );
  return {
    past: [...history.past, history.present].slice(-limit),
    present: next,
    future: [],
    revision: history.revision + 1,
  };
}
export function undoPlacement(history: PlacementHistory): PlacementHistory {
  const previous = history.past.at(-1);
  return previous
    ? {
        past: history.past.slice(0, -1),
        present: previous,
        future: [history.present, ...history.future],
        revision: history.revision + 1,
      }
    : history;
}
export function redoPlacement(history: PlacementHistory): PlacementHistory {
  const next = history.future[0];
  return next
    ? {
        past: [...history.past, history.present],
        present: next,
        future: history.future.slice(1),
        revision: history.revision + 1,
      }
    : history;
}

/** In-memory recovery survives tab/project changes, including a failed explicit draft save. */
const drafts = new Map<string, { history: PlacementHistory; savedRevision: number }>();
export const placementDrafts = {
  hasUnsaved: () =>
    [...drafts.values()].some((draft) => draft.history.revision !== draft.savedRevision),
  get: (projectId: string) => drafts.get(projectId),
  set: (projectId: string, history: PlacementHistory, savedRevision: number) => {
    drafts.set(projectId, { history, savedRevision });
  },
};

export function placementBoardFiles(files: { path: string }[]): string[] {
  return files
    .map((f) => f.path)
    .filter((p) => /\.kicad_pcb$/i.test(p) && !p.startsWith("placement/"))
    .sort(
      (a, b) =>
        Number(b === "board.kicad_pcb") - Number(a === "board.kicad_pcb") || a.localeCompare(b),
    );
}

export const loadPlacementLibrary = () => import("./library").then((m) => m.placementLibrary);
export const loadPlacementExamples = () => import("./examples.json").then((m) => m.default);
