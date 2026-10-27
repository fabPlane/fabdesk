import { BoardSourceSelection, PCB_SVG_COORDINATE_SYSTEM, PcbPartPosition, PcbInspectionCoordinateSystem, type PcbPartInspection } from "@fabdesk/protocol";
import type { CoreClient } from "./CoreClient";

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
export function pcbToolJson(value: unknown): Record<string, unknown> {
  let body = record(value);
  if (body && "result" in body) body = record(body.result);
  if (body && body.isError === true) throw new Error(typeof body.text === "string" ? body.text : "The native operation could not complete.");
  if (body && "json" in body) body = record(body.json);
  if (!body) throw new Error("The native operation returned no usable data.");
  return body;
}
/** A scoped result must echo the owner; legacy/root responses cannot drive member controls. */
export function pcbToolJsonForSource(value: unknown, projectId: string, board?: BoardSourceSelection): Record<string, unknown> {
  const body = pcbToolJson(value);
  if (board) {
    const owner = record(body._board);
    if (owner?.projectId !== projectId || owner.sourceId !== board.sourceId || owner.manifestSha256 !== board.manifestSha256) throw new Error("This result does not belong to the selected board source. Select the board again.");
  }
  return body;
}
export function parsePcbPartInspection(value: unknown): PcbPartInspection {
  const body = pcbToolJson(value), contract = record(body.contract), results = record(body.results), components = record(results?.components);
  if (contract?.name !== "fabdesk.pcb-inspection" || contract.version !== "2.0.0" || !PcbInspectionCoordinateSystem.safeParse(body.coordinateSystem).success || typeof body.revision !== "string" || !/^[a-f0-9]{64}$/.test(body.revision) || !Array.isArray(components?.rows)) throw new Error("A saved PCB inspection is required before positioning parts.");
  const parts = components.rows.map((row) => PcbPartPosition.parse(row));
  if (new Set(parts.map((part) => part.ref)).size !== parts.length) throw new Error("Duplicate part references need resolving before positioning parts.");
  return { sourceSha256: body.revision, parts, truncated: components.truncated === true };
}
export async function inspectPcbParts(client: Pick<CoreClient, "callTool">, projectId: string, query: { near?: { x: number; y: number; radius: number }; reference?: string }, board?: BoardSourceSelection): Promise<PcbPartInspection> {
  const selector = board ? Object.freeze(BoardSourceSelection.parse(board)) : undefined;
  return parsePcbPartInspection(pcbToolJsonForSource(await client.callTool("pcb_inspect", { projectId, ...(selector ? { board: selector } : {}), kinds: ["components"], limitPerKind: 200, ...(query.near ? { near: { ...query.near } } : {}), ...(query.reference ? { references: [query.reference] } : {}) }), projectId, selector));
}
export function parsePartPositionInput(input: { x: string; y: string; rotation: string }): { x: number; y: number; rotation: number } | null {
  if (Object.values(input).some((value) => !value.trim())) return null;
  const x = Number(input.x), y = Number(input.y), rotation = Number(input.rotation);
  if (![x, y, rotation].every(Number.isFinite) || Math.abs(x) > 10_000 || Math.abs(y) > 10_000 || Math.abs(rotation) > 360_000) return null;
  return { x, y, rotation: ((rotation % 360) + 360) % 360 };
}
export function pcbPlacementWarnings(value: unknown): { affectedCopper: number; possibleShorts: number } {
  const body = pcbToolJson(value);
  let affectedCopper = 0, possibleShorts = 0;
  for (const item of Object.values(record(body.staleCopper) ?? {})) {
    const row = record(item);
    if (typeof row?.staleCount === "number" && Number.isFinite(row.staleCount) && row.staleCount > 0) affectedCopper += row.staleCount;
    if (typeof row?.shortedCount === "number" && Number.isFinite(row.shortedCount) && row.shortedCount > 0) possibleShorts += row.shortedCount;
  }
  return { affectedCopper, possibleShorts };
}

/** Only exporter-stamped SVGs have a verified native origin; never infer it from SVG size. */
export function pcbSvgHasNativeCoordinates(svg: string): boolean {
  const root = svg.match(/<svg\b[^>]*>/i)?.[0] ?? "";
  return root.includes(`data-fabplane-coordinate-system="${PCB_SVG_COORDINATE_SYSTEM}"`) || root.includes(`data-fabplane-coordinate-system='${PCB_SVG_COORDINATE_SYSTEM}'`);
}
