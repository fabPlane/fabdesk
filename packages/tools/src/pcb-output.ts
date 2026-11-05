import { outputRevision } from "./output-revision";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import { jailPath, writeAtomic } from "./fs";
import { ToolError, type ToolContext, type ToolOutput } from "./registry";

export const expectedPcbSource = z.string().regex(/^[a-f0-9]{64}$/).optional().describe("Captured saved PCB SHA-256; required for an assembly source export");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Run existing PCB exporters on immutable input and publish only after source/ownership checks. */
export async function withPcbOutput(ctx: ToolContext, expected: string | undefined, operation: (staged: ToolContext) => Promise<ToolOutput>, existingFabrication = false): Promise<ToolOutput> {
  const project = ctx.requireProject();
  if (ctx.board && !ctx.runInScope) throw new ToolError("Board ownership was not established by this host.", "precondition");
  if (ctx.board && !expected) throw new ToolError("Inspect the selected PCB before exporting and provide expectedSourceSha256.", "precondition");
  const board = await jailPath(project.dir, "board.kicad_pcb");
  const source = await readFile(board).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") { if (existingFabrication && !ctx.board) return null; throw new ToolError("board.kicad_pcb not found", "precondition"); } throw error; }), revision = source ? hash(source) : null;
  if (expected && expected !== revision) throw new ToolError("The PCB changed before export. Review its latest source and try again.", "precondition");
  const scratch = await mkdtemp(join(tmpdir(), "fabplane-pcb-output-"));
  const captured: Array<{ path: string; sha256: string }> = [];
  try {
    if (source) await writeFile(join(scratch, "board.kicad_pcb"), source);
    // Packaging uses only the selected source's already-saved manufacturing files.
    if (existingFabrication) {
      const names = (await readdir(await jailPath(project.dir, "exports/gerbers")).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; })).filter(name => !name.endsWith(".revision.json")).map(name => `exports/gerbers/${name}`);
      for (const path of [...names, "exports/positions.csv", "exports/bom.csv"]) {
        let bytes: Buffer;
        try { bytes = await readFile(await jailPath(project.dir, path)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        captured.push({ path, sha256: hash(bytes) });
        await writeAtomic(await jailPath(scratch, path), bytes);
      }
    }
    const stagedProject = { ...project, dir: scratch };
    const result = await operation({ ...ctx, project: stagedProject, requireProject: () => stagedProject });
    if (result.isError) return result;
    const pending: Array<{ path: string; bytes: Buffer; destination: string }> = [];
    for (const root of ["exports", "renders"]) {
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(join(scratch, dir), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; })) {
          const path = `${dir}/${entry.name}`;
          if (entry.isDirectory()) await walk(path);
          else if (entry.isFile() && !captured.some(file => file.path === path)) pending.push({ path, bytes: await readFile(await jailPath(scratch, path)), destination: await jailPath(project.dir, path) });
          else if (!entry.isFile()) throw new ToolError("The exporter produced an unsupported file entry.", "precondition");
        }
      };
      await walk(root);
    }
    for (const file of pending) if (/\.(json|md|txt|csv|svg|dxf|lbrn2)$/i.test(file.path)) file.bytes = Buffer.from(file.bytes.toString("utf8").replaceAll(scratch, project.dir));
    const receipts = await Promise.all(pending.filter(file => /\.(png|jpe?g|webp|svg|stl|obj|step|stp|zip|csv|gbr|gbl|gtl|gbo|gto|gbs|gts|gbp|gtp|gm1|gko|drl|pdf|dxf|lbrn2|net|pos)$/i.test(file.path)).map(async file => ({
      path: `${file.path}.revision.json`, destination: await jailPath(project.dir, `${file.path}.revision.json`),
      bytes: Buffer.from(outputRevision(ctx, file.path, file.bytes, existingFabrication ? "saved-files" : "pcb", existingFabrication ? captured : [{ path: "board.kicad_pcb", sha256: revision! }])),
    })));
    const publish = async () => {
      ctx.signal.throwIfAborted();
      if (revision && hash(await readFile(board)) !== revision) throw new ToolError("PCB changed while exporting. Previous outputs were kept; review the source and try again.", "precondition");
      for (const file of captured) if (hash(await readFile(await jailPath(project.dir, file.path))) !== file.sha256) throw new ToolError("Manufacturing files changed while packaging. Create the ZIP again from the saved outputs.", "precondition");
      for (const file of [...pending, ...receipts]) await jailPath(project.dir, file.path);
      for (const file of [...pending, ...receipts]) await writeAtomic(file.destination, file.bytes);
    };
    if (ctx.runInScope) await ctx.runInScope(publish); else await publish();
    // Existing exporters return absolute paths in text, JSON and inline images.
    const remap = (value: unknown): unknown => typeof value === "string" ? value.replaceAll(scratch, project.dir) : Array.isArray(value) ? value.map(remap) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item)])) : value;
    return remap(result) as ToolOutput;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
