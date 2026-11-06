import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { AssemblyBoardModelRevision, AssemblySchematicPreviewRevision, RootSchematicPreviewRevision, BoardModelRevision, OutputRevision, PcbPreviewRevision, ProductVideoInputRevision, type FileEntry } from "@fabdesk/protocol";
import { jailPath } from "@fabdesk/tools";

/** Reuse exporter receipts; never turn an imported file's mtime into a generation date. */
export class OutputGenerationTimes {
  private hashes = new Map<string, { signature: string; sha256: string }>();

  private async hash(path: string): Promise<string | null> {
    const before = await stat(path, { bigint: true }).catch(() => null);
    if (!before?.isFile()) return null;
    const signature = `${before.dev}:${before.ino}:${before.size}:${before.mtimeNs}:${before.ctimeNs}`;
    const cached = this.hashes.get(path);
    if (cached?.signature === signature) return cached.sha256;
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(path)) digest.update(chunk);
    const after = await stat(path, { bigint: true });
    if (signature !== `${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}`) return null;
    const sha256 = digest.digest("hex");
    if (this.hashes.size >= 512) this.hashes.delete(this.hashes.keys().next().value!);
    this.hashes.set(path, { signature, sha256 });
    return sha256;
  }

  async attach(dir: string, projectId: string, files: FileEntry[]): Promise<FileEntry[]> {
    const byPath = new Map(files.map(file => [file.path, file]));
    const dates = new Map<string, string>();
    // Sequential streaming hashes bound memory, including large videos/models.
    for (const file of files) {
      const isReceipt = file.path.endsWith(".revision.json") || /(?:^|\/)exports\/product-video\.json$/.test(file.path);
      if (!isReceipt || file.size > 2_000_000) continue;
      const prefixFor = (logical: string) => {
        if (!file.path.endsWith(logical)) return null;
        const prefix = file.path.slice(0, -logical.length);
        return !prefix || prefix.endsWith("/") ? prefix : null;
      };
      const record = async (prefix: string, path: string, sha256: string, date: string) => {
        const entry = byPath.get(prefix + path);
        if (!entry || !entry.size || !Number.isFinite(Date.parse(date))) return;
        if (await this.hash(await jailPath(dir, entry.path)) === sha256) dates.set(entry.path, date);
      };
      try {
        const raw: unknown = JSON.parse(await readFile(await jailPath(dir, file.path), "utf8"));
        if (file.path.endsWith(".revision.json")) {
          const generic = OutputRevision.safeParse(raw);
          if (generic.success && generic.data.projectId === projectId && prefixFor(generic.data.artifact + ".revision.json") !== null) {
            await record(prefixFor(generic.data.artifact + ".revision.json")!, generic.data.artifact, generic.data.artifactSha256, generic.data.generatedAt);
            continue;
          }
          const member = AssemblyBoardModelRevision.safeParse(raw), model = BoardModelRevision.safeParse(raw), pcb = PcbPreviewRevision.safeParse(raw);
          const receipt = member.success ? member.data.boardSource.projectId === projectId ? member.data : null : model.success && prefixFor(model.data.artifact + ".revision.json") === "" ? model.data : pcb.success ? pcb.data : null;
          if (receipt && prefixFor(receipt.artifact + ".revision.json") !== null) await record(prefixFor(receipt.artifact + ".revision.json")!, receipt.artifact, receipt.artifactSha256, receipt.generatedAt);
          const schematic = AssemblySchematicPreviewRevision.safeParse(raw), rootSchematic = RootSchematicPreviewRevision.safeParse(raw);
          const drawing = schematic.success && schematic.data.boardSource.projectId === projectId ? schematic.data : rootSchematic.success && rootSchematic.data.projectId === projectId && prefixFor("renders/schematic.revision.json") === "" ? rootSchematic.data : null;
          if (drawing && prefixFor("renders/schematic.revision.json") !== null) {
            for (const sheet of drawing.sheets) await record(prefixFor("renders/schematic.revision.json")!, sheet.path, sheet.sha256, drawing.generatedAt);
          }
        } else if (prefixFor("exports/product-video.json") !== null && raw && typeof raw === "object" && "revision" in raw && "generatedAt" in raw && typeof raw.generatedAt === "string") {
          const video = ProductVideoInputRevision.safeParse(raw.revision);
          if (video.success) for (const output of video.data.outputs) await record(prefixFor("exports/product-video.json")!, output.path, output.sha256, raw.generatedAt);
        }
      } catch { /* Missing, changing or invalid receipts leave the honest file-time fallback. */ }
    }
    return files.map(file => dates.has(file.path) ? { ...file, generatedAt: dates.get(file.path)! } : file);
  }
}
