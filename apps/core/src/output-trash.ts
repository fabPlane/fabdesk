import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath, readFile, readdir, mkdir, rename, link, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod/v4";
import { AssemblyRelativePath, OutputRevision, ProductVideoInputRevision, savedOutputKind, type OutputTrashCandidate, type OutputTrashEntry, type OutputTrashResult } from "@fabdesk/protocol";
import { inspectProjectBoardSources, jailPath, type ProjectHandle } from "@fabdesk/tools";

const Entry = z.object({ id: z.string().uuid(), path: AssemblyRelativePath, size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/), trashedAt: z.string().datetime() }).strict();
const ROOT = ".fabdesk/output-trash";
const message = (error: unknown) => error instanceof Error ? error.message : "The file could not be moved safely.";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const identity = (s: Awaited<ReturnType<typeof lstat>>) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;

/** Recoverable output-only moves. All mutations recheck ownership, active work and reviewed bytes. */
export class OutputTrash {
  private locks = new Map<string, Promise<unknown>>();
  constructor(private busy: (id: string) => string | null) {}

  private async serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const pending = this.locks.get(id) ?? Promise.resolve();
    const next = pending.catch(() => {}).then(fn); this.locks.set(id, next);
    try { return await next; } finally { if (this.locks.get(id) === next) this.locks.delete(id); }
  }
  private async owned(root: string, path: string, existing: boolean) {
    const abs = await jailPath(root, path), canonical = await realpath(root);
    // Reject internal aliases too, including symlinked ancestors. Restore may create only the final file.
    if (existing) {
      const st = await lstat(abs);
      if (!st.isFile() || st.nlink !== 1 || await realpath(abs) !== join(canonical, path)) throw new Error("Shared, linked or non-regular files are protected.");
    } else if (await realpath(dirname(abs)) !== join(canonical, dirname(path))) throw new Error("Linked output folders are protected.");
    return abs;
  }
  private async hash(abs: string) {
    const before = await lstat(abs);
    const sha = createHash("sha256"); for await (const chunk of createReadStream(abs)) sha.update(chunk);
    if (identity(before) !== identity(await lstat(abs))) throw new Error("File changed during review. Review it again.");
    return { sha256: sha.digest("hex"), stat: before };
  }
  private async inventory(project: ProjectHandle, dependencies = true) {
    const sources = await inspectProjectBoardSources(project);
    // ProjectStore's presentation listing tolerates unreadable folders; deletion must not.
    const files: Array<{ path: string; size: number }> = [];
    const walk = async (dir: string, prefix = ""): Promise<void> => {
      for (const item of await readdir(dir, { withFileTypes: true })) {
        if ([".git", "node_modules", ".fabdesk"].includes(item.name)) continue;
        const path = prefix + item.name, abs = join(dir, item.name);
        if (item.isDirectory()) await walk(abs, path + "/");
        else if (item.isFile() || item.isSymbolicLink()) files.push({ path, size: (await lstat(abs)).size });
        if (files.length >= 8001) throw new Error("Project file inventory exceeds the safe review limit.");
      }
    };
    if (dependencies) await walk(project.dir);
    if (files.length >= 8001) throw new Error("This project's file inventory exceeds the safe review limit. No files will be removed.");
    const members = sources.mode === "assembly" ? sources.sources.flatMap(row => row.source.location === "project" ? [{ prefix: row.source.directory === "." ? "" : row.source.directory + "/", allowed: row.status === "available" || row.status === "missing" }] : []).sort((a, b) => b.prefix.length - a.prefix.length) : [];
    const protectedInputs = new Map<string, string>();
    for (const file of dependencies ? files : []) {
      if (!file.path.endsWith(".revision.json") && !/(?:^|\/)exports\/product-video\.json$/.test(file.path)) continue;
      // Only exporter receipts under deliverable folders can establish output dependencies.
      if (!/(?:^|\/)(renders|exports)\//.test(file.path)) continue;
      if (file.size > 2_000_000) throw new Error(`Dependency record too large to review: ${file.path}`);
      const raw: unknown = JSON.parse(await readFile(await this.owned(project.dir, file.path, true), "utf8"));
      const generic = OutputRevision.safeParse(raw);
      if (generic.success && file.path.endsWith(generic.data.artifact + ".revision.json")) {
        const prefix = file.path.slice(0, -(generic.data.artifact + ".revision.json").length);
        if (await lstat(await jailPath(project.dir, prefix + generic.data.artifact)).catch(() => null)) {
          for (const input of generic.data.inputs) protectedInputs.set(prefix + input.path, file.path);
        }
      }
      if (/(?:^|\/)exports\/product-video\.json$/.test(file.path) && raw && typeof raw === "object" && "revision" in raw) {
        const revision = ProductVideoInputRevision.parse(raw.revision), prefix = file.path.slice(0, -"exports/product-video.json".length);
        let retained = false;
        for (const output of revision.outputs) if (await lstat(await jailPath(project.dir, prefix + output.path)).catch(() => null)) retained = true;
        if (retained) for (const input of revision.inputs) protectedInputs.set(prefix + input.path, file.path);
      }
    }
    return { sources, members, protectedInputs };
  }
  private qualify(path: string, info: Awaited<ReturnType<OutputTrash["inventory"]>>) {
    const member = info.members.find(row => path.startsWith(row.prefix));
    if (member && !member.allowed) throw new Error("This board source is blocked; resolve its ownership before removing outputs.");
    if (!savedOutputKind(member ? path.slice(member.prefix.length) : path)) throw new Error("Protected source, metadata or intermediate file. Only Library outputs can be moved to Trash.");
    const dependency = info.protectedInputs.get(path);
    if (dependency) throw new Error(`Recorded input referenced by ${dependency}. Keep it with the dependent output.`);
  }
  async review(project: ProjectHandle, paths: string[]): Promise<{ files: OutputTrashCandidate[] }> {
    const active = this.busy(project.id);
    if (active) return { files: [...new Set(paths)].map(path => ({ path, eligible: false, reason: active })) };
    let info: Awaited<ReturnType<OutputTrash["inventory"]>>;
    try { info = await this.inventory(project); }
    catch (error) { return { files: [...new Set(paths)].map(path => ({ path, eligible: false, reason: `Source/dependency review unavailable. ${message(error)}` })) }; }
    const files: OutputTrashCandidate[] = [];
    for (const path of new Set(paths)) {
      try {
        this.qualify(path, info);
        const busy = this.busy(project.id); if (busy) throw new Error(busy);
        const abs = await this.owned(project.dir, path, true), { sha256, stat } = await this.hash(abs);
        const parent = await lstat(dirname(abs));
        if (!(stat.mode & 0o222) || !(parent.mode & 0o222)) throw new Error("Read-only output or folder. Preview and download remain available.");
        files.push({ path, eligible: true, reason: "Recoverable from Output Trash. Only this file is moved.", size: stat.size, token: digest(JSON.stringify({ projectId: project.id, path, sha256, identity: identity(stat), manifest: info.sources.manifestSha256 })) });
      } catch (error) { files.push({ path, eligible: false, reason: message(error) }); }
    }
    return { files };
  }
  async move(project: ProjectHandle, requested: Array<{ path: string; token: string }>): Promise<OutputTrashResult[]> {
    return this.serial(project.id, async () => {
      const results: OutputTrashResult[] = [];
      for (const file of requested) {
        try {
          const reviewed = (await this.review(project, [file.path])).files[0]!;
          if (!reviewed.eligible || reviewed.token !== file.token) throw new Error(reviewed.eligible ? "File or board ownership changed since confirmation. Review it again." : reviewed.reason);
          const src = await this.owned(project.dir, file.path, true), before = await this.hash(src);
          const id = randomUUID(), dir = await jailPath(project.dir, `${ROOT}/${id}`);
          await mkdir(dir, { recursive: true });
          await this.owned(project.dir, `${ROOT}/${id}/entry.json`, false);
          const entry: OutputTrashEntry = { id, path: file.path, size: before.stat.size, sha256: before.sha256, trashedAt: new Date().toISOString() };
          await writeFile(join(dir, "entry.json"), JSON.stringify(entry), { flag: "wx" });
          const latest = (await this.review(project, [file.path])).files[0]!;
          if (!latest.eligible || latest.token !== file.token || this.busy(project.id)) throw new Error("Output changed or project work started. Nothing was moved; review again.");
          await rename(src, join(dir, "payload"));
          results.push({ path: file.path, id, ok: true, reason: "Moved to Output Trash." });
        } catch (error) { results.push({ path: file.path, ok: false, reason: message(error) }); }
      }
      return results;
    });
  }
  async list(project: ProjectHandle): Promise<OutputTrashEntry[]> {
    const dir = await jailPath(project.dir, ROOT);
    const names = await readdir(dir).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    const result: OutputTrashEntry[] = [];
    for (const id of names) {
      if (!z.string().uuid().safeParse(id).success) continue;
      try {
        const entry = Entry.parse(JSON.parse(await readFile(await this.owned(project.dir, `${ROOT}/${id}/entry.json`, true), "utf8")));
        if (entry.id !== id) throw new Error("Trash identity mismatch.");
        await this.owned(project.dir, `${ROOT}/${id}/payload`, true);
        result.push(entry);
      } catch (error) {
        const payload = await lstat(await jailPath(project.dir, `${ROOT}/${id}/payload`)).catch(() => null);
        if (payload) throw new Error(`Recovery entry ${id} needs attention. Its saved bytes are retained; Trash could not be fully inspected. ${message(error)}`);
        // A failed move can leave prepared metadata without a payload. It never removed an output.
      }
    }
    return result.sort((a, b) => b.trashedAt.localeCompare(a.trashedAt));
  }
  async restore(project: ProjectHandle, ids: string[]): Promise<OutputTrashResult[]> {
    return this.serial(project.id, async () => {
      const results: OutputTrashResult[] = [];
      for (const id of new Set(ids)) {
        let path = id;
        try {
          const entry = Entry.parse(JSON.parse(await readFile(await this.owned(project.dir, `${ROOT}/${id}/entry.json`, true), "utf8")));
          if (entry.id !== id) throw new Error("Trash identity mismatch.");
          path = entry.path;
          this.qualify(entry.path, { ...(await this.inventory(project, false)), protectedInputs: new Map() });
          const busy = this.busy(project.id); if (busy) throw new Error(busy);
          const payload = await this.owned(project.dir, `${ROOT}/${id}/payload`, true);
          if ((await this.hash(payload)).sha256 !== entry.sha256) throw new Error("Trashed file bytes changed; restore was stopped.");
          const dest = await this.owned(project.dir, entry.path, false);
          if (await lstat(dest).catch(() => null)) throw new Error("A file already exists at this path. It was not overwritten; the saved copy stays in Trash.");
          if (this.busy(project.id)) throw new Error("Project work started. Try restoring when it finishes.");
          // Exclusive hard-link creation cannot overwrite a regenerated output; unlink only our stored copy after success.
          await link(payload, dest);
          let cleanup = "";
          try { await unlink(payload); } catch { cleanup = " The recovery copy could not be retired; its original path was restored successfully."; }
          results.push({ path, id, ok: true, reason: "Restored to its original path." + cleanup });
        } catch (error) { results.push({ path, id, ok: false, reason: message(error) }); }
      }
      return results;
    });
  }
}
