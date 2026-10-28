import { AssemblySchematicInspection, type BoardSourceSelection } from "@fabdesk/protocol";
/** Reject root, old scope or malformed tool results before showing source-specific native facts. */
export function captureAssemblySchematicInspection(result: unknown, projectId: string, board: BoardSourceSelection) {
  const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  let body = object(result); if (body && "result" in body) body = object(body.result);
  // Incomplete hierarchies intentionally return isError with structured, source-bound issues.
  const data = AssemblySchematicInspection.parse(body && "json" in body ? body.json : body);
  if (data._board.projectId !== projectId || data._board.sourceId !== board.sourceId || data._board.manifestSha256 !== board.manifestSha256) throw new Error("The schematic inspection belongs to a different board source. Inspect this source again.");
  return data;
}
