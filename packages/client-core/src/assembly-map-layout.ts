import type { ProjectBoardSources } from "@fabdesk/protocol";

/** Device-local project-map coordinates. These never describe KiCad or installed positions. */
export type AssemblyMapPosition = { units: "canvas-px"; sourceId: string; x: number; y: number };
export type AssemblyMapLayout = Record<string, AssemblyMapPosition>;
export const assemblyMapLayoutKey = (endpoint: string, projectId: string) => JSON.stringify([endpoint, projectId]);

export function parseAssemblyMapPosition(value: unknown): AssemblyMapPosition | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const { units, sourceId, x, y } = row;
  return units === "canvas-px" && typeof sourceId === "string" && sourceId.length > 0 && sourceId.length <= 80 && typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= 1e6 && typeof y === "number" && Number.isFinite(y) && Math.abs(y) <= 1e6 ? { units, sourceId, x, y } : null;
}

/** Local storage is untrusted; only positions for the current declared instance/source pair apply. */
export function restoreAssemblyMapLayout(data: ProjectBoardSources, saved: unknown): Map<string, AssemblyMapPosition> {
  const positions = new Map<string, AssemblyMapPosition>();
  if (data.mode !== "assembly" || !data.assembly || !saved || typeof saved !== "object" || Array.isArray(saved)) return positions;
  const record = saved as Record<string, unknown>;
  for (const instance of data.assembly.instances) {
    if (!Object.prototype.hasOwnProperty.call(record, instance.id)) continue;
    const position = parseAssemblyMapPosition(record[instance.id]);
    if (position?.sourceId === instance.sourceId) positions.set(instance.id, position);
  }
  return positions;
}
