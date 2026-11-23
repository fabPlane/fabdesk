import { SchematicFocus, SchematicFocusChoices, type ProjectBoardSources } from "@fabdesk/protocol";
import { captureAssemblySourceSelection, type AssemblySceneSelection } from "./assembly-scene";

const sha = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))).map(n => n.toString(16).padStart(2, "0")).join("");
/** Verify exact native and preview bytes; navigation never establishes electrical validity. */
export async function schematicFocusFilesMatch(focus: SchematicFocus, source: string, svg: string): Promise<boolean> {
  const [nativeHash, svgHash] = await Promise.all([sha(source), sha(svg)]);
  return nativeHash === focus.sourceSha256 && svgHash === focus.svgSha256;
}

/** Validate present membership and every qualified path before changing a canvas. */
export function schematicFocusScope(focus: SchematicFocus, sources: ProjectBoardSources, previous?: AssemblySceneSelection): { board: AssemblySceneSelection | null } | null {
  if (focus.projectId !== sources.projectId) return null;
  if (!focus.board) return sources.mode === "single" ? { board: null } : null;
  if (sources.mode !== "assembly" || sources.manifestSha256 !== focus.board.manifestSha256) return null;
  const row = sources.sources.find(row => row.source.id === focus.board!.sourceId);
  if (row?.source.location !== "project" || row.status !== "available" || !row.schematicPath) return null;
  const prefix = row.source.directory === "." ? "" : `${row.source.directory}/`;
  const inSource = (path: string) => prefix ? path.startsWith(prefix) : !sources.sources.some(other => other.source.id !== row.source.id && other.source.location === "project" && other.source.directory !== "." && path.startsWith(`${other.source.directory}/`));
  if (![focus.sourcePath, focus.svgPath, ...(focus.sourceFiles?.map(file => file.path) ?? [])].every(inSource)) return null;
  const board = captureAssemblySourceSelection(sources, focus.board.sourceId, previous);
  return board ? { board } : null;
}

/** Child or project metadata edits invalidate focus just as root edits do. */
export async function schematicFocusHierarchyMatches(focus: SchematicFocus, read: (path: string) => Promise<string>): Promise<boolean> {
  if (!focus.sourceFiles) return true; // Legacy single-root request still verifies its own source separately.
  return (await Promise.all(focus.sourceFiles.map(async file => await sha(await read(file.path)) === file.sha256))).every(Boolean);
}

/** Recognized structured tool envelopes only; arbitrary chat prose cannot trigger navigation. */
export function schematicFocusFromResult(output: unknown): SchematicFocus | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const body = output as Record<string, unknown>;
  if (body.isError === true) return null;
  const parsed = SchematicFocus.safeParse(body.focus);
  if (parsed.success) return parsed.data;
  for (const key of ["structuredContent", "structured_content", "json", "result"]) {
    const nested = body[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const data = nested as Record<string, unknown>;
      if (data.isError === true) continue;
      const candidate = SchematicFocus.safeParse(data.focus);
      if (candidate.success) return candidate.data;
      if (key === "result" && data.structuredContent && typeof data.structuredContent === "object") {
        const content = data.structuredContent as Record<string, unknown>;
        if (content.isError === true) continue;
        const wrapped = SchematicFocus.safeParse(content.focus);
        if (wrapped.success) return wrapped.data;
      }
    }
  }
  return null;
}

export function schematicFocusChoicesFromResult(output: unknown): SchematicFocusChoices | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const body = output as Record<string, unknown>;
  if (body.isError === true) return null;
  for (const candidate of [body, body.json, body.structuredContent, body.structured_content, body.result]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const row = candidate as Record<string, unknown>;
    if (row.isError === true) continue;
    const parsed = SchematicFocusChoices.safeParse(row.focusChoices);
    if (parsed.success) return parsed.data;
    if (row.structuredContent && typeof row.structuredContent === "object") {
      const content = row.structuredContent as Record<string, unknown>;
      if (content.isError === true) continue;
      const wrapped = SchematicFocusChoices.safeParse(content.focusChoices);
      if (wrapped.success) return wrapped.data;
    }
  }
  return null;
}
