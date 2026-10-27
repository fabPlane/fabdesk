import { PcbOutlineSegment, PcbInspectionCoordinateSystem, type PcbOutlineInspection } from "@fabdesk/protocol";
import type { CoreClient } from "./CoreClient";
import { pcbToolJson } from "./pcb-parts";
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Only a complete unlocked native rectangle, identified by its original IDs, supports dimensions. */
export function parsePcbOutlineInspection(value: unknown): PcbOutlineInspection {
  const body = pcbToolJson(value), contract = record(body.contract), group = record(record(body.results)?.board_geometry);
  if (contract?.name !== "fabdesk.pcb-inspection" || contract.version !== "2.0.0" || !PcbInspectionCoordinateSystem.safeParse(body.coordinateSystem).success || typeof body.revision !== "string" || !/^[a-f0-9]{64}$/.test(body.revision) || !Array.isArray(group?.rows)) throw Error("Inspect the saved PCB before changing its outline.");
  const base = { sourceSha256: body.revision, edgeIds: [] as string[], bounds: null };
  const blocked = (reason: string): PcbOutlineInspection => ({ ...base, editable: false, reason });
  if (group.truncated !== false || group.returned !== group.total || group.returned !== group.rows.length) return blocked("The outline inspection is incomplete. Edit this boundary in KiCad.");
  if (!group.rows.length) return { ...base, editable: true, reason: null };
  const parsed = group.rows.map(row => PcbOutlineSegment.safeParse(row));
  if (parsed.some(row => !row.success)) return blocked("This runtime cannot verify native outline IDs and locks. Update it before resizing.");
  const rows = parsed.map(row => row.data!);
  if (rows.some(row => row.locked)) return blocked("This outline is locked. Unlock its edges or group in KiCad before resizing.");
  const points = rows.flatMap(row => [row.start, row.end]);
  const bounds = { minX: Math.min(...points.map(p => p.x)), minY: Math.min(...points.map(p => p.y)), maxX: Math.max(...points.map(p => p.x)), maxY: Math.max(...points.map(p => p.y)) };
  if (bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) return blocked("The outline has no usable width or height.");
  if (rows.length === 1 && rows[0]!.kind === "rectangle") return { sourceSha256: body.revision, edgeIds: [rows[0]!.id], bounds, editable: true, reason: null };
  if (rows.length !== 4 || rows.some(row => row.kind !== "segment")) return blocked("This outline is not a simple rectangle. Edit its shape in KiCad.");
  const corners = new Map<string, number>(), edges = new Set<string>();
  for (const row of rows) {
    const { start: a, end: b } = row;
    if ((a.x === b.x) === (a.y === b.y)) return blocked("The outline is not an axis-aligned rectangle.");
    const keys = [a, b].map(p => `${p.x},${p.y}`);
    for (const p of [a, b]) if (![bounds.minX, bounds.maxX].includes(p.x) || ![bounds.minY, bounds.maxY].includes(p.y)) return blocked("The rectangle has additional edge vertices.");
    for (const key of keys) corners.set(key, (corners.get(key) ?? 0) + 1);
    edges.add(keys.sort().join("|"));
  }
  if (corners.size !== 4 || [...corners.values()].some(count => count !== 2) || edges.size !== 4 || new Set(rows.map(row => row.id)).size !== 4) return blocked("The outline has duplicate or disconnected edges.");
  return { sourceSha256: body.revision, edgeIds: rows.map(row => row.id), bounds, editable: true, reason: null };
}
// PCB inspection v2 uses native BoardLayer enum 47 for Edge.Cuts. Its string alias
// is not normalized by older spatial providers; using the explicit enum avoids an empty result.
export async function inspectPcbOutline(client: Pick<CoreClient, "callTool">, projectId: string): Promise<PcbOutlineInspection> {
  return parsePcbOutlineInspection(await client.callTool("pcb_inspect", { projectId, kinds: ["board_geometry"], layers: [47], limitPerKind: 200 }));
}
export function resizedOutlinePoints(bounds: PcbOutlineInspection["bounds"], width: string, height: string): { x: number; y: number }[] | null {
  if (!width.trim() || !height.trim()) return null;
  const w = Number(width), h = Number(height);
  if (![w, h].every(Number.isFinite) || w < .000001 || h < .000001 || w > 1000 || h > 1000) return null;
  const x = bounds?.minX ?? 0, y = bounds?.minY ?? 0;
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}
