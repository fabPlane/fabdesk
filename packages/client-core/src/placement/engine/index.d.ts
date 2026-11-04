import type {
  Ast,
  Bounds,
  Point,
  PlacementPart,
  PlacementSession,
  PlacementFinding,
  PlacementReview,
  NetEdge,
} from "../types";
export function clone<T>(value: T): T;
export function saveAutosave(
  storage: Pick<Storage, "setItem">,
  key: string,
  text: string,
): Promise<string>;
export function decodeAutosave(text: string): Promise<string>;
export function val(value: unknown): string;
export function partFromNode(node: Ast, index: number): PlacementPart;
export function renewFootprintIds(node: Ast): void;
export function replacementPreview(
  part: PlacementPart,
  text: string,
  name: string,
): {
  candidate: PlacementPart;
  error: string | null;
  compatible: boolean;
  pads: { number: string; net: string }[];
  oldSize: number[];
  newSize: number[];
};
export function placementScore(session: PlacementSession): number;
export function sampleArc(start: Point, mid: Point, end: Point): Point[];
export function parse(text: string): Ast;
export function serialize(node: Ast): string;
export function child(node: Ast, name: string): Ast | undefined;
export function children(node: Ast, name: string): Ast[];
export function importBoard(text: string, name?: string): PlacementSession;
export function loadSession(text: string): PlacementSession;
export function exportBoard(session: PlacementSession): string;
export function replaceFootprint(part: PlacementPart, text: string, name: string): void;
export function boardPath(session: PlacementSession): string;
export function boardContours(session: PlacementSession): Point[][];
export function worldPoint(part: PlacementPart, x: number, y: number): Point;
export function worldBounds(part: PlacementPart): Bounds;
export function polygons(part: PlacementPart): Point[][];
export function bounds(polygons: Point[][]): Bounds;
export function inside(point: Point, polygon: Point[], boundary?: boolean): boolean;
export function issues(session: PlacementSession): PlacementFinding[];
export function spacingGuidelines(session: PlacementSession): PlacementFinding[];
export function expanded(session: PlacementSession, ids: string[]): string[];
export function moveParts(
  session: PlacementSession,
  ids: string[],
  dx: number,
  dy: number,
): string[];
export function rotateParts(session: PlacementSession, ids: string[], degrees?: number): void;
export function groupParts(session: PlacementSession, ids: string[]): string;
export function ungroupParts(session: PlacementSession, ids: string[]): void;
export function alignParts(session: PlacementSession, ids: string[], mode: string): void;
export function spaceParts(
  session: PlacementSession,
  ids: string[],
  axis: string,
  gap: number,
): void;
export function setAnchor(session: PlacementSession, part: PlacementPart, edge: string): void;
export function shove(
  session: PlacementSession,
  ids: string[],
): { moved: string[]; timedOut: boolean; issues: PlacementFinding[] };
export function relax(session: PlacementSession): {
  moved: string[];
  timedOut: boolean;
  issues: PlacementFinding[];
};
export function resizeBoard(
  session: PlacementSession,
  w: number,
  h: number,
  adjust?: boolean,
): PlacementFinding[];
export function netEdges(session: PlacementSession, filter?: string): NetEdge[];
export function connectionLength(session: PlacementSession): number;
export function suggestPlacement(
  session: PlacementSession,
  ids?: string[],
  options?: { budgetMs?: number; maxSweeps?: number; allowRotation?: boolean },
): {
  candidate: PlacementSession;
  before: number;
  after: number;
  timedOut: boolean;
  accepted: number;
};
export function reviewPlacement(before: PlacementSession, after: PlacementSession): PlacementReview;
export function connectedNeighbors(
  session: PlacementSession,
  ids: string[],
): { id: string; ref: string; net: string; distance: number }[];
export function nearestClearance(
  session: PlacementSession,
  ids: string[],
): {
  a: string;
  b: string;
  ref: string;
  distance: number;
  overlap: boolean;
  from?: Point;
  to?: Point;
} | null;
export function validatePlacementSettings(session: PlacementSession): void;
