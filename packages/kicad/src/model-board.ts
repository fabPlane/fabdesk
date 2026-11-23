import { mkdtemp, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export type ModelVariants = ReadonlyMap<number, { declared: string; path: string }>;
/** Replace only footprint model path tokens; never labels, transforms or other saved data. */
export function rewriteModelPaths(text: string, resolvePath: (declared: string) => string | null, variants?: ModelVariants): string {
  const frames: Array<{ head: string; atoms: number }> = [];
  const changes: Array<{ start: number; end: number; value: string }> = [];
  const resolved = new Map<string, string | null>();
  let footprint = -1;
  const tokens = /"(?:\\.|[^"\\])*"|\(|\)|[^\s()"]+/g;
  for (const token of text.matchAll(tokens)) {
    const value = token[0];
    if (value === "(") { frames.push({ head: "", atoms: 0 }); continue; }
    if (value === ")") { frames.pop(); continue; }
    const frame = frames.at(-1);
    if (!frame) continue;
    if (frame.atoms++ === 0) {
      frame.head = value;
      if (value === "footprint" && frames.at(-2)?.head === "kicad_pcb") footprint++;
      continue;
    }
    if (frame.head !== "model" || frame.atoms !== 2 || frames.at(-2)?.head !== "footprint" || frames.at(-3)?.head !== "kicad_pcb" || !value.startsWith('"')) continue;
    const declared = value.slice(1, -1).replace(/\\(.)/g, "$1");
    if (!resolved.has(declared)) resolved.set(declared, resolvePath(declared));
    const variant = variants?.get(footprint);
    const path = variant?.declared === declared ? variant.path : resolved.get(declared);
    if (path && path !== declared) changes.push({ start: token.index, end: token.index + value.length, value: JSON.stringify(path.replaceAll("\\", "/")) });
  }
  for (const change of changes.reverse()) text = text.slice(0, change.start) + change.value + text.slice(change.end);
  return text;
}

/** Export-only copy; keep the native PCB and its custom model transforms byte-for-byte intact. */
export async function withModelBoard<T>(board: string, resolvePath: (declared: string) => string | null, run: (board: string) => Promise<T>, prepareVariants?: (text: string) => Promise<ModelVariants>): Promise<T> {
  const original = await readFile(board, "utf8");
  const rewritten = rewriteModelPaths(original, resolvePath, await prepareVariants?.(original));
  if (rewritten === original) return run(board);
  const scratch = await mkdtemp(join(tmpdir(), "fabdesk-model-paths-")), path = join(scratch, basename(board));
  try {
    await writeFile(path, rewritten);
    // Preserve project variables/settings when the native CLI opens the temporary PCB.
    if (/\.kicad_pcb$/i.test(board)) await copyFile(board.replace(/\.kicad_pcb$/i, ".kicad_pro"), path.replace(/\.kicad_pcb$/i, ".kicad_pro")).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    return await run(path);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
