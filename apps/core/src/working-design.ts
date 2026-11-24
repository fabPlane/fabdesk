/** A conversation's working source, separate from UI navigation and repository-owned files. */
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { z } from "zod/v4";
import { ToolError, captureNativeDesign, writeAtomic, type ProjectHandle } from "@fabdesk/tools";
const Selection = z.object({
  sourcePath: z.string().min(1).max(1024),
  requestStartedAt: z.number(),
});
export class WorkingDesigns {
  private writes = new Map<string, Promise<unknown>>();
  constructor(private home: string) {}
  private file(project: ProjectHandle, threadId?: string) {
    return join(
      this.home,
      "working-designs",
      createHash("sha256")
        .update(JSON.stringify([project.id, project.dir, threadId ?? null]))
        .digest("hex") + ".json",
    );
  }
  async selection(project: ProjectHandle, threadId?: string) {
    try {
      return Selection.parse(JSON.parse(await readFile(this.file(project, threadId), "utf8")));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return null;
    }
  }
  async describe(project: ProjectHandle, threadId?: string) {
    const selection = await this.selection(project, threadId);
    if (!selection) return { sourcePath: null };
    const native = await captureNativeDesign(project.dir, selection.sourcePath);
    return {
      ...selection,
      sourceRevision: native.sourceRevision,
      board: native.board,
      schematic: native.schematic,
      projectFile: native.projectFile,
      inputCount: Object.keys(native.inputs).length,
    };
  }
  async select(
    project: ProjectHandle,
    sourcePath: string,
    threadId?: string,
    requestStartedAt = Date.now(),
  ) {
    sourcePath = normalize(sourcePath).replaceAll("\\", "/");
    await captureNativeDesign(project.dir, sourcePath);
    const file = this.file(project, threadId);
    const pending = (this.writes.get(file) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const previous = await this.selection(project, threadId);
        if (previous && previous.requestStartedAt > requestStartedAt)
          throw new ToolError(
            "A newer conversation request has already chosen its working design",
            "precondition",
          );
        await mkdir(join(this.home, "working-designs"), { recursive: true });
        await writeAtomic(file, JSON.stringify({ sourcePath, requestStartedAt }));
        return this.describe(project, threadId);
      });
    this.writes.set(file, pending);
    try {
      return await pending;
    } finally {
      if (this.writes.get(file) === pending) this.writes.delete(file);
    }
  }
}
