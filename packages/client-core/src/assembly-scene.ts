import { BoardSourceSelection, type ProjectAssembly, type ProjectBoardSources } from "@fabdesk/protocol";
import { pcbToolJson, parsePcbPartInspection } from "./pcb-parts";
import { parsePcbOutlineInspection } from "./pcb-outline";
import type { CoreClient } from "./CoreClient";

export type AssemblySceneSelection = BoardSourceSelection & { projectId: string; instanceId: string };
export type AssemblySceneNode = { instance: ProjectAssembly["instances"][number]; source: ProjectBoardSources["sources"][number] | undefined; x: number; y: number; width: number; height: number };
export function assemblyScene(data: ProjectBoardSources) {
  if (data.mode !== "assembly" || !data.assembly) throw new Error("An explicit assembly declaration is required");
  const nodes: AssemblySceneNode[] = data.assembly.instances.map((instance, index) => ({ instance, source: data.sources.find(row => row.source.id === instance.sourceId), x: instance.presentation?.x ?? index % 3 * 290, y: instance.presentation?.y ?? Math.floor(index / 3) * 230, width: 210, height: 158 }));
  const links = data.assembly.connections.map(connection => ({ connection, a: nodes.find(node => node.instance.id === connection.a.instanceId)!, b: nodes.find(node => node.instance.id === connection.b.instanceId)! }));
  if (links.some(link => !link.a || !link.b)) throw new Error("A connection endpoint is not declared");
  const minX = Math.min(...nodes.map(node => node.x)) - 64, minY = Math.min(...nodes.map(node => node.y)) - 64;
  const maxX = Math.max(...nodes.map(node => node.x + node.width)) + 64, maxY = Math.max(...nodes.map(node => node.y + node.height)) + 64;
  return { nodes, links, bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY } };
}
/** Logical ports sit outside cards; they are not physical connector coordinates. */
export function assemblyLinkShape(a: AssemblySceneNode, b: AssemblySceneNode) {
  const dx = b.x - a.x, dy = b.y - a.y, horizontal = Math.abs(dx) >= Math.abs(dy);
  const start = horizontal ? { x: a.x + (dx >= 0 ? a.width + 5 : -5), y: a.y + 58 } : { x: a.x + a.width / 2, y: a.y + (dy >= 0 ? a.height + 5 : -5) };
  const end = horizontal ? { x: b.x + (dx >= 0 ? -5 : b.width + 5), y: b.y + 58 } : { x: b.x + b.width / 2, y: b.y + (dy >= 0 ? -5 : b.height + 5) };
  const middle = horizontal ? (start.x + end.x) / 2 : (start.y + end.y) / 2;
  return { start, end, path: horizontal ? `M${start.x},${start.y} C${middle},${start.y} ${middle},${end.y} ${end.x},${end.y}` : `M${start.x},${start.y} C${start.x},${middle} ${end.x},${middle} ${end.x},${end.y}` };
}
export function captureAssemblySelection(data: ProjectBoardSources, instanceId: string): AssemblySceneSelection | null {
  const instance = data.assembly?.instances.find(row => row.id === instanceId);
  return data.mode === "assembly" && data.manifestSha256 && instance ? { projectId: data.projectId, instanceId, sourceId: instance.sourceId, manifestSha256: data.manifestSha256 } : null;
}
/** A changed declaration requires a new selection, even when a familiar ID is reused. */
export function assemblySelectionState(data: ProjectBoardSources, selection: AssemblySceneSelection): "owned" | "unavailable" | "stale" {
  if (data.mode !== "assembly" || selection.projectId !== data.projectId || selection.manifestSha256 !== data.manifestSha256 || data.assembly?.instances.find(row => row.id === selection.instanceId)?.sourceId !== selection.sourceId) return "stale";
  const source = data.sources.find(row => row.source.id === selection.sourceId);
  return source?.status === "available" && source.source.location === "project" ? "owned" : "unavailable";
}
export async function inspectAssemblyBoard(client: Pick<CoreClient, "callTool">, projectId: string, board: BoardSourceSelection) {
  const selector = Object.freeze(BoardSourceSelection.parse(board));
  const body = pcbToolJson(await client.callTool("pcb_inspect", { projectId, board: selector, kinds: ["components", "board_geometry"], limitPerKind: 200 }));
  const identity = body._board as Record<string, unknown> | undefined;
  if (identity?.projectId !== projectId || identity.sourceId !== selector.sourceId || identity.manifestSha256 !== selector.manifestSha256) throw new Error("This inspection does not belong to the selected board source. Select the board again.");
  const parts = parsePcbPartInspection(body);
  const results = body.results as Record<string, { rows: Array<Record<string, unknown>>; total: number; returned: number; truncated: boolean }>;
  const geometry = results.board_geometry;
  if (!geometry || !Array.isArray(geometry.rows)) throw new Error("The selected board has no usable native geometry inspection.");
  const edges = geometry.rows.filter(row => row && row.layer === 47);
  const outline = parsePcbOutlineInspection({ ...body, results: { ...results, board_geometry: geometry?.truncated === false ? { rows: edges, total: edges.length, returned: edges.length, truncated: false } : geometry } });
  const total = results.components?.total;
  return { ...parts, partCount: typeof total === "number" && Number.isSafeInteger(total) && total >= parts.parts.length ? total : parts.parts.length, outlineBounds: outline.bounds };
}
