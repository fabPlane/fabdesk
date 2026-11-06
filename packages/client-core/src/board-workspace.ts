/** Client access and pure helpers for board history and cross-board part links. */
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import type {
  BoardFile,
  BoardPartChangeRow,
  BoardPartSummary,
  BoardRevisionComparison,
  BoardTimeline,
  BoardTimelineEntry,
  BoardView,
  PartEndpoint,
  PartLinkList,
  PinCheck,
  PinCheckRow,
  PartPinPair,
  PartLinkSuggestion,
} from "@fabdesk/protocol";
import { isGeneratedNet, isRailNet, namedNet, netName } from "@fabdesk/protocol";
import type { CoreClient } from "./CoreClient";
import { BOARD_WORKSPACE_QUERY_KEY } from "./board-workspace-keys";
import { pcbToolJson } from "./pcb-parts";
import { useCoreClient } from "./provider";

const KEY = BOARD_WORKSPACE_QUERY_KEY;

async function callJson<T>(client: CoreClient, tool: string, args: Record<string, unknown>): Promise<T> {
  const call = await client.callTool(tool, args);
  const job = call.jobId ? await client.waitJob(call.jobId) : null;
  if (job && job.status !== "done") throw new Error(job.error ?? "This board operation could not finish.");
  return pcbToolJson(job ? job.result : call) as unknown as T;
}

export function useProjectBoards(projectId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: [KEY, projectId, "boards"], enabled: !!projectId, staleTime: 30_000,
    queryFn: async () => (await callJson<{ boards: BoardFile[] }>(client, "board_list", { projectId })).boards,
  });
}

export function useBoardTimeline(projectId: string | null, pcbPath: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: [KEY, projectId, "timeline", pcbPath], enabled: !!projectId && !!pcbPath, staleTime: 30_000,
    queryFn: () => callJson<BoardTimeline>(client, "board_revision_timeline", { projectId, pcbPath, limit: 40 }),
  });
}

const comparisonQuery = (client: CoreClient, projectId: string | null, pcbPath: string | null, from: string | null, to: string | null) => ({
  queryKey: [KEY, projectId, "compare", pcbPath, from, to],
  staleTime: 60_000,
  queryFn: () => callJson<BoardRevisionComparison>(client, "board_revision_compare", { projectId, pcbPath, from, to, drawings: true }),
});

/** The last comparison stays on screen while the next loads, so stepping does not blank the boards. */
export function useBoardComparison(projectId: string | null, pcbPath: string | null, from: string | null, to: string | null) {
  const client = useCoreClient();
  return useQuery({ ...comparisonQuery(client, projectId, pcbPath, from, to), enabled: !!projectId && !!pcbPath && !!from && !!to, placeholderData: keepPreviousData });
}

/** Load the neighbouring steps ahead of time, so moving back and forth is immediate. */
export function usePrefetchBoardComparisons(projectId: string | null, pcbPath: string | null, pairs: ReadonlyArray<{ from: string; to: string }>) {
  const client = useCoreClient(), queryClient = useQueryClient();
  const key = JSON.stringify(pairs);
  useEffect(() => {
    if (!projectId || !pcbPath) return;
    for (const pair of JSON.parse(key) as Array<{ from: string; to: string }>) void queryClient.prefetchQuery(comparisonQuery(client, projectId, pcbPath, pair.from, pair.to));
  }, [client, key, pcbPath, projectId, queryClient]);
}

export function useBoardView(projectId: string | null, pcbPath: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: [KEY, projectId, "view", pcbPath], enabled: !!projectId && !!pcbPath, staleTime: 30_000,
    queryFn: () => callJson<BoardView>(client, "board_view", { projectId, pcbPath, drawing: true }),
  });
}

export function usePartLinks(projectId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: [KEY, projectId, "links"], enabled: !!projectId, staleTime: 15_000,
    queryFn: () => callJson<PartLinkList>(client, "connection_list", { projectId }),
  });
}

export function usePartLinkSuggestions(projectId: string | null, boardA: string | null, boardB: string | null, enabled: boolean) {
  const client = useCoreClient();
  return useQuery({
    queryKey: [KEY, projectId, "suggest", boardA, boardB], enabled: enabled && !!projectId && !!boardA && !!boardB, staleTime: 30_000,
    queryFn: async () => (await callJson<{ suggestions: PartLinkSuggestion[] }>(client, "connection_suggest", { projectId, boardA, boardB, limit: 20 })).suggestions,
  });
}

/** Run one board-workspace write, then refresh everything derived from project boards and links. */
export function useBoardWorkspaceAction(projectId: string | null) {
  const client = useCoreClient(), queryClient = useQueryClient();
  return useCallback(async <T = Record<string, unknown>>(tool: string, args: Record<string, unknown>): Promise<T> => {
    const result = await callJson<T>(client, tool, { projectId, ...args });
    await queryClient.invalidateQueries({ queryKey: [KEY, projectId] });
    return result;
  }, [client, projectId, queryClient]);
}


export function changeCountTotal(entry: Pick<BoardTimelineEntry, "changes">): number {
  const counts = entry.changes;
  return counts ? counts.added + counts.removed + counts.moved + counts.changed + counts.renamed : 0;
}

export function timelineEntryLabel(entry: Pick<BoardTimelineEntry, "kind" | "title">): string {
  if (entry.kind !== "export") return entry.title;
  const id = /^mechanical-([a-f0-9]{8})/.exec(entry.title)?.[1];
  return id ? `Export ${id}` : entry.title.split("/").at(-1)!.replace(/\.kicad_pcb$/i, "");
}

/** The neighbouring step when moving through a timeline, or null at either end. */
export function timelineStep(entries: readonly BoardTimelineEntry[], index: number, direction: -1 | 1): number | null {
  const next = index + direction;
  return next >= 1 && next < entries.length ? next : null;
}

/** The step a timeline card selects. The oldest card has no earlier revision, so it opens the first step. */
export function timelineIndexForCard(entries: readonly BoardTimelineEntry[], position: number): number {
  return Math.min(Math.max(position, 1), Math.max(entries.length - 1, 0));
}

/** The compared pair for a timeline selection: an entry against the one before it. */
export function timelinePair(entries: readonly BoardTimelineEntry[], index: number): { from: BoardTimelineEntry; to: BoardTimelineEntry } | null {
  const to = entries[index], from = entries[index - 1];
  return to && from ? { from, to } : null;
}

export function defaultTimelineIndex(entries: readonly BoardTimelineEntry[]): number {
  for (let index = entries.length - 1; index > 0; index -= 1) if (changeCountTotal(entries[index]!) > 0) return index;
  return entries.length - 1;
}

/** The pin under the point on one part, or the nearest pad within reach. */
export function hitTestBoardPad(part: BoardPartSummary, point: { x: number; y: number }, reach = 0.4): string | null {
  let best: string | null = null, bestDistance = reach;
  for (const pad of part.pads) {
    const { minX, minY, maxX, maxY } = pad.bounds;
    const distance = Math.hypot(Math.max(minX - point.x, 0, point.x - maxX), Math.max(minY - point.y, 0, point.y - maxY));
    if (distance === 0) return pad.pin;
    if (distance <= bestDistance) { best = pad.pin; bestDistance = distance; }
  }
  return best;
}

/** Smallest part under the point, else the nearest within reach. Stacked parts favour the small one. */
export function hitTestBoardPart(parts: readonly BoardPartSummary[], point: { x: number; y: number }, reach = 1): BoardPartSummary | null {
  let inside: BoardPartSummary | null = null, insideArea = Infinity, near: BoardPartSummary | null = null, nearDistance = reach;
  for (const part of parts) {
    const { minX, minY, maxX, maxY } = part.bounds;
    if (point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY) {
      const area = (maxX - minX) * (maxY - minY);
      if (area < insideArea) { inside = part; insideArea = area; }
      continue;
    }
    const distance = Math.hypot(Math.max(minX - point.x, 0, point.x - maxX), Math.max(minY - point.y, 0, point.y - maxY));
    if (distance <= nearDistance) { near = part; nearDistance = distance; }
  }
  return inside ?? near;
}

const SELECTED = "#2563eb";
/** References come from design files, so keep them inside the selector and the stylesheet. */
const cssString = (value: string) => value.replace(/[\\"<>\n]/g, (c) => (c === "\n" ? " " : c === "<" ? "\\3c " : c === ">" ? "\\3e " : `\\${c}`));

export function highlightBoardDrawing(svg: string, opts: {
  /** Parts to mark as selected. */
  refs?: readonly string[];
  /** Keep these change kinds at full strength and fade the others. */
  roles?: readonly string[];
  /** Part bounds to zoom to, only when asked for. */
  focus?: BoardPartSummary["bounds"] | null;
  /** Pins on the selected parts: those already mapped, and the one in focus. */
  mappedPins?: readonly string[];
  activePin?: string | null;
}): string {
  const refs = opts.refs ?? [], roles = opts.roles ?? [];
  if (!refs.length && !roles.length && !opts.focus) return svg;
  const rules: string[] = [];
  if (refs.length || roles.length) rules.push(".bp-part{opacity:.3}");
  for (const role of roles) rules.push(`.bp-part[data-role="${cssString(role)}"]{opacity:1}`);
  for (const ref of refs) {
    const selector = `.bp-part[data-ref="${cssString(ref)}"]`;
    rules.push(`${selector}{opacity:1}`, `${selector} .bp-body{stroke:${SELECTED};stroke-width:.3;fill:${SELECTED};fill-opacity:.18}`, `${selector} .bp-pad{fill:${SELECTED}}`, `${selector} .bp-label{fill:#1e3a8a}`, `${selector} .bp-pin{display:inline}`);
    for (const pin of opts.mappedPins ?? []) rules.push(`${selector} .bp-pad[data-pin="${cssString(pin)}"]{fill:#16a34a}`);
    if (opts.activePin) rules.push(`${selector} .bp-pad[data-pin="${cssString(opts.activePin)}"]{fill:#ea580c;stroke:#7c2d12;stroke-width:.12}`);
  }
  let out = svg.replace(/(<svg\b[^>]*>)/, `$1<style><![CDATA[${rules.join("")}]]></style>`);
  if (opts.focus) {
    const { minX, minY, maxX, maxY } = opts.focus;
    const width = Math.max(maxX - minX + 8, 16), height = Math.max(maxY - minY + 8, 12);
    const viewBox = `${(minX + maxX - width) / 2} ${(minY + maxY - height) / 2} ${width} ${height}`;
    out = out.replace(/(<svg\b[^>]*?)viewBox="[^"]*"/, `$1viewBox="${viewBox}"`);
  }
  return out;
}

export function sameEndpoint(a: PartEndpoint | null | undefined, b: PartEndpoint | null | undefined): boolean {
  return !!a && !!b && a.boardPath === b.boardPath && a.ref === b.ref;
}

/** The first link touching this part, and which end is the other one. */
export function partLinkPeer<T extends { a: PartEndpoint; b: PartEndpoint }>(links: readonly T[], endpoint: PartEndpoint): { link: T; peer: PartEndpoint } | null {
  for (const link of links) {
    if (sameEndpoint(link.a, endpoint)) return { link, peer: link.b };
    if (sameEndpoint(link.b, endpoint)) return { link, peer: link.a };
  }
  return null;
}

export function boardFileLabel(path: string): string {
  return path.split("/").at(-1)!.replace(/\.kicad_pcb$/i, "");
}

export const sharedNetLabel = (count: number) => count === 0 ? "No shared net names" : `${count} shared net name${count === 1 ? "" : "s"}`;

/** Connectors first, then natural reference order, since most links join connectors. */
export function sortedBoardParts<T extends { ref: string }>(parts: readonly T[]): T[] {
  const rank = (ref: string) => (/^(?:J|P|CN|CON|X|FPC|USB)\d/i.test(ref) ? 0 : 1);
  return [...parts].sort((a, b) => rank(a.ref) - rank(b.ref) || a.ref.localeCompare(b.ref, undefined, { numeric: true }));
}

export function changeDescription(change: BoardPartChangeRow): string {
  if (change.kind === "added") return "Only on the newer revision";
  if (change.kind === "removed") return "Only on the older revision";
  if (change.kind === "renamed") return `Was ${change.fromRef}`;
  const moved = change.distance ? `Moved ${Number(change.distance.toFixed(2))} mm` : "";
  const others = change.reasons.filter((reason) => reason !== "moved").join(", ");
  return [moved, others].filter(Boolean).join(" · ") || "Changed";
}

/** One row per pin, in natural order. A pin number can repeat across several pads. */
export function partPins(part: Pick<BoardPartSummary, "pads"> | null | undefined): Array<{ pin: string; net?: string }> {
  const seen = new Map<string, { pin: string; net?: string }>();
  for (const pad of part?.pads ?? []) if (!seen.has(pad.pin)) seen.set(pad.pin, { pin: pad.pin, ...(pad.net ? { net: pad.net } : {}) });
  return [...seen.values()].sort((a, b) => a.pin.localeCompare(b.pin, undefined, { numeric: true }));
}

/**
 * A starting pin map from matching net names. It is a suggestion until someone saves it. A repeated
 * net such as GND gets one target pin each: the same pin number when that carries the net, then the
 * remaining pins in order. Pins left over stay unmapped rather than doubling up on a guess.
 */
export function suggestPinMap(source: Pick<BoardPartSummary, "pads"> | null | undefined, target: Pick<BoardPartSummary, "pads"> | null | undefined): Record<string, string> {
  const open = new Map<string, string[]>();
  for (const pin of partPins(target)) {
    const net = namedNet(pin.net);
    if (net) open.set(net, [...(open.get(net) ?? []), pin.pin]);
  }
  const pins = partPins(source), map: Record<string, string> = {};
  for (const pin of pins) {
    const free = open.get(namedNet(pin.net) ?? "");
    const same = free?.indexOf(pin.pin) ?? -1;
    if (same >= 0) { map[pin.pin] = pin.pin; free!.splice(same, 1); }
  }
  for (const pin of pins) {
    const next = map[pin.pin] === undefined ? open.get(namedNet(pin.net) ?? "")?.shift() : undefined;
    if (next !== undefined) map[pin.pin] = next;
  }
  return map;
}

/** A saved link's pin map, read from whichever end is selected. */
export function linkPinMap(link: { a: PartEndpoint; pins?: readonly PartPinPair[] | undefined }, source: PartEndpoint): Record<string, string> {
  const fromA = sameEndpoint(link.a, source), map: Record<string, string> = {};
  for (const pair of link.pins ?? []) map[fromA ? pair.a : pair.b] = fromA ? pair.b : pair.a;
  return map;
}

/** A pin map as stored on a link, whichever end was selected. */
export function pinPairsForLink(map: Readonly<Record<string, string>>, sourceIsA: boolean): PartPinPair[] {
  return Object.entries(map).filter(([, target]) => target).map(([from, to]) => (sourceIsA ? { a: from, b: to } : { a: to, b: from }));
}

/** Named signal nets of a part by their comparable name, so a sheet prefix on one board does not hide a match. */
export function signalNetNames(nets: readonly string[] | null | undefined): Set<string> {
  return new Set((nets ?? []).filter((net) => !isGeneratedNet(net) && !isRailNet(net)).map(netName));
}
/** How many named signal nets two parts share by name. */
export function sharedSignalNetCount(source: { nets: readonly string[] } | null | undefined, part: { nets: readonly string[] }): number {
  const named = signalNetNames(source?.nets);
  return signalNetNames(part.nets.filter((net) => named.has(netName(net)))).size;
}

/** Parts most likely to connect first: those sharing named signal nets, then connectors, then by reference. */
export function rankConnectionTargets<T extends { ref: string; nets: readonly string[] }>(source: { nets: readonly string[] } | null | undefined, parts: readonly T[]): T[] {
  const shared = (part: T) => sharedSignalNetCount(source, part);
  const order = new Map(sortedBoardParts(parts).map((part, index) => [part.ref, index]));
  return [...parts].sort((a, b) => shared(b) - shared(a) || order.get(a.ref)! - order.get(b.ref)!);
}

export type PairLine = {
  id: string;
  tone: "linked" | "review" | "missing" | "draft" | PinCheckRow["kind"];
  left: { x: number; y: number };
  right: { x: number; y: number };
  label?: string;
  selected?: boolean;
};
type LineLink = { id: string; a: PartEndpoint; b: PartEndpoint; state: "current" | "needs-review" | "missing" };
const center = (box: BoardPartSummary["bounds"]) => ({ x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 });

/** Every saved link with one end on each board shown, read from either direction. */
export function pairLinkLines(links: readonly LineLink[], leftBoard: string | null, rightBoard: string | null, leftParts: readonly BoardPartSummary[], rightParts: readonly BoardPartSummary[], selectedId?: string | null): PairLine[] {
  return links.flatMap((link) => {
    const forward = link.a.boardPath === leftBoard && link.b.boardPath === rightBoard;
    const backward = link.b.boardPath === leftBoard && link.a.boardPath === rightBoard;
    if (!forward && !backward) return [];
    const leftEnd = forward ? link.a : link.b, rightEnd = forward ? link.b : link.a;
    const left = leftParts.find((part) => part.ref === leftEnd.ref), right = rightParts.find((part) => part.ref === rightEnd.ref);
    if (!left || !right) return [];
    return [{
      id: link.id,
      tone: link.state === "current" ? "linked" as const : link.state === "needs-review" ? "review" as const : "missing" as const,
      left: center(left.bounds),
      right: center(right.bounds),
      ...(link.id === selectedId ? { selected: true } : {}),
    }];
  });
}

/** One line per stated pin, coloured by what the net names say about it. */
export function pairPinLines(check: Pick<PinCheck, "rows">, sourceIsLeft: boolean, source: BoardPartSummary | null, target: BoardPartSummary | null): PairLine[] {
  if (!source || !target) return [];
  return check.rows.flatMap((row) => {
    const from = source.pads.find((pad) => pad.pin === row.a), to = target.pads.find((pad) => pad.pin === row.b);
    if (!from || !to) return [];
    const a = center(from.bounds), b = center(to.bounds);
    return [{ id: `pin:${row.a}:${row.b}`, tone: row.kind, left: sourceIsLeft ? a : b, right: sourceIsLeft ? b : a, ...(row.aNet ? { label: netName(row.aNet) } : {}) }];
  });
}

/** Parts on the other board worth clicking, by how many named signal nets they share with this one. */
export function connectionCandidates(source: { nets: readonly string[] } | null | undefined, parts: readonly { ref: string; nets: readonly string[] }[], limit = 12): Map<string, number> {
  const scored = parts.map((part) => ({ ref: part.ref, shared: sharedSignalNetCount(source, part) })).filter((row) => row.shared > 0);
  return new Map(scored.sort((a, b) => b.shared - a.shared).slice(0, limit).map((row) => [row.ref, row.shared]));
}

/** A one-line reading of a pin check. Names only, so it never says verified. */
export function pinCheckLabel(check: Pick<PinCheck, "status" | "rows" | "unmapped">): string {
  if (check.status === "none") return "No pins stated yet";
  const count = (kind: PinCheckRow["kind"]) => check.rows.filter((row) => row.kind === kind).length;
  const parts = [
    count("conflict") ? `${count("conflict")} power conflict${count("conflict") === 1 ? "" : "s"}` : "",
    count("differs") ? `${count("differs")} with different names` : "",
    count("unnamed") ? `${count("unnamed")} without a net name` : "",
    check.unmapped.length ? `${check.unmapped.length} named not mapped` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : `All ${check.rows.length} pins agree by net name`;
}
