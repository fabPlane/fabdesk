import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { extractBoardFeatures } from "@fabdesk/kicad";
import { NativeSourceContext } from "@fabdesk/protocol";
import {
  withoutNativeLayout,
  captureNativeDesign,
  jailPath,
  NativeRevisionConflict,
  ToolError,
  type NativeFileLayout,
  type ProjectHandle,
} from "@fabdesk/tools";
import type { WorkingDesigns } from "./working-design";

/** A captured source owns real native files. Logical board.* names are transport aliases only. */
export async function bindNativeSource(
  root: ProjectHandle,
  input: NativeSourceContext,
  designs: WorkingDesigns,
): Promise<NativeFileLayout> {
  const context = Object.freeze(NativeSourceContext.parse(input));
  if (root.id !== context.projectId)
    throw new ToolError("Native source belongs to another project", "precondition");
  const selected = await designs.selection(root, context.threadId);
  if (selected?.sourcePath !== context.sourcePath)
    throw new NativeRevisionConflict(
      "Working native source changed. Reopen the board before continuing.",
    );
  const native = await captureNativeDesign(root.dir, context.sourcePath);
  const source = await jailPath(root.dir, context.sourcePath),
    directory = await realpath(dirname(source));
  if (directory !== resolve(dirname(source)))
    throw new ToolError("Native project directory is aliased", "precondition");
  const before = await stat(directory),
    rootDirectory = await realpath(root.dir),
    rootIdentity = await stat(rootDirectory);
  const stem = basename(context.sourcePath).replace(/\.kicad_(pcb|sch|pro)$/i, "");
  const files = Object.fromEntries(
    ["pcb", "sch", "pro", "dru", "prl"].map((extension) => [
      `board.kicad_${extension}`,
      `${stem}.kicad_${extension}`,
    ]),
  );
  const cacheDirectory = join(
    directory,
    ".fabdesk",
    "native",
    createHash("sha256").update(stem).digest("hex").slice(0, 24),
  );
  let board: ReturnType<ProjectHandle["manifest"]>["board"] = { layers: 2 };
  if (native.board) {
    const text = native.files.get(native.board)!.toString("utf8");
    let bounds: ReturnType<typeof extractBoardFeatures>["outline"] | undefined;
    try {
      bounds = extractBoardFeatures(text).outline;
    } catch {
      /* Incomplete boards still need their normal editing/checking tools. */
    }
    const header = text.slice(0, text.indexOf("(setup") > 0 ? text.indexOf("(setup") : 20_000);
    const layers = [...header.matchAll(/^\s*\(\d+\s+"[^"]+"\s+(?:signal|power|mixed)\b/gm)].length;
    board = {
      ...board,
      ...(layers ? { layers } : {}),
      ...(bounds
        ? { widthMm: bounds.maxX - bounds.minX, heightMm: bounds.maxY - bounds.minY }
        : {}),
    };
  }
  const { importedBoard: _imported, ...manifest } = root.manifest();
  const project: ProjectHandle = Object.freeze({
    id: root.id,
    name: root.name,
    dir: directory,
    manifest: () => ({ ...manifest, board }),
    updateManifest: async () => {
      throw new ToolError(
        "Workspace defaults cannot replace native project settings. Change the captured native design explicitly.",
        "precondition",
      );
    },
  });
  const layout: NativeFileLayout = {
    context,
    project,
    directory,
    files,
    cacheDirectory,
    captureRevision: () =>
      withoutNativeLayout(
        async () => (await captureNativeDesign(root.dir, context.sourcePath)).sourceRevision,
      ),
    async assertCurrent() {
      try {
        const currentRoot = await stat(rootDirectory),
          current = await stat(directory);
        if (
          (await realpath(root.dir)) !== rootDirectory ||
          currentRoot.ino !== rootIdentity.ino ||
          currentRoot.dev !== rootIdentity.dev ||
          (await realpath(directory)) !== directory ||
          current.ino !== before.ino ||
          current.dev !== before.dev
        )
          throw Error("Directory ownership changed");
        if ((await designs.selection(root, context.threadId))?.sourcePath !== context.sourcePath)
          throw Error("Working source changed");
        for (const path of [
          join(directory, ".fabdesk"),
          join(directory, ".fabdesk", "native"),
          cacheDirectory,
        ]) {
          const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
          if (entry && (!entry.isDirectory() || (await realpath(path)) !== path))
            throw Error("Native workspace cache is aliased");
        }
        for (const name of [...Object.values(files), "fp-lib-table", "sym-lib-table"]) {
          const path = join(directory, name),
            entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return null;
              throw error;
            });
          if (entry && (!entry.isFile() || entry.nlink !== 1 || (await realpath(path)) !== path))
            throw Error("Native document is aliased");
        }
        if (!(await stat(source)).isFile()) throw Error("Working source missing");
      } catch {
        throw new NativeRevisionConflict(
          "Working native source ownership changed. No new save is allowed; select the source again.",
        );
      }
    },
  };
  await layout.assertCurrent();
  return Object.freeze(layout);
}
