import { SchematicFocus } from "@fabdesk/protocol";

const sha = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))).map(n => n.toString(16).padStart(2, "0")).join("");
/** Verify exact native and preview bytes; navigation never establishes electrical validity. */
export async function schematicFocusFilesMatch(focus: SchematicFocus, source: string, svg: string): Promise<boolean> {
  const [nativeHash, svgHash] = await Promise.all([sha(source), sha(svg)]);
  return nativeHash === focus.sourceSha256 && svgHash === focus.svgSha256;
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
        const wrapped = SchematicFocus.safeParse((data.structuredContent as Record<string, unknown>).focus);
        if (wrapped.success) return wrapped.data;
      }
    }
  }
  return null;
}
