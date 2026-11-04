import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, posix } from "node:path";
import { readSavedBoardModels, resolveModelPath } from "@fabdesk/kicad";
import { jailPath, projectRelative } from "../fs";
import { ToolError } from "../registry";

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Dependency = {
  board: string;
  declared: string;
  status: "packaged" | "external" | "missing" | "unresolved";
  files: { path: string; sha256: string }[];
};

/** Keep project-owned model references portable without changing editable source boards.
 * External library assets remain explicit dependencies; never read outside the project jail. */
export async function bundleEnclosureModels(dir: string, boards: Record<string, Uint8Array>) {
  const files: Record<string, Uint8Array> = {};
  const dependencies: Dependency[] = [];
  const sources = new Map<string, Uint8Array>();
  let total = 0;
  for (const [board, bytes] of Object.entries(boards)) {
    const nativeBoard = await jailPath(dir, board);
    const archiveBoard = projectRelative(dir, nativeBoard);
    const text = Buffer.from(bytes).toString("utf8");
    const replacements = new Map<string, string>();
    const declaredModels = new Set(
      readSavedBoardModels(text).flatMap((fp) => fp.models.map((m) => m.declared)),
    );
    for (const declared of declaredModels) {
      // KIPRJMOD is the directory containing the native board for standalone board files.
      const resolution = resolveModelPath(declared, dirname(nativeBoard));
      const dependency: Dependency = { board, declared, status: "unresolved", files: [] };
      dependencies.push(dependency);
      if (!resolution.path) continue;
      const unique = new Map<string, string>();
      for (const path of [resolution.path, ...resolution.substitutionCandidates]) {
        const key = process.platform === "win32" ? path.toLowerCase() : path;
        if (!unique.has(key)) unique.set(key, path);
      }
      const paths = [...unique.values()];
      const loaded: { path: string; bytes: Uint8Array; sha256: string }[] = [];
      try {
        // Validate every candidate before reading any of them, including substituted STEP files.
        const safe = await Promise.all(paths.map((p) => jailPath(dir, p)));
        const seen = new Set<string>();
        for (const candidate of safe) {
          // Case-insensitive filesystems can resolve .step and .STEP to the same file.
          // Canonicalize only after every candidate has passed the project jail.
          const canonical = await realpath(candidate).catch(() => null);
          if (!canonical) continue; // Missing substitution candidates are ordinary dependencies.
          const path = await jailPath(await realpath(dir), canonical);
          if (seen.has(path)) continue;
          seen.add(path);
          let content = sources.get(path);
          if (!content) {
            const info = await stat(path).catch(() => null);
            if (!info?.isFile()) continue;
            if (info.size > 50 * 1024 * 1024 || total + info.size > 250 * 1024 * 1024)
              throw new ToolError(
                "Project model files exceed the enclosure export limit (50 MB each, 250 MB total).",
                "invalid_args",
              );
            content = await readFile(path);
            total += content.length;
            sources.set(path, content);
          }
          loaded.push({ path, bytes: content, sha256: hash(content) });
        }
      } catch (error) {
        if (error instanceof ToolError && /path .*project directory/.test(error.message)) {
          dependency.status = "external";
          continue;
        }
        throw error;
      }
      if (!loaded.length) {
        dependency.status = "missing";
        continue;
      }
      // A VRML model and its STEP substitutions share a stem, preserving KiCad's substitution.
      const stem = hash(JSON.stringify(loaded.map((f) => [extname(f.path), f.sha256])));
      for (const file of loaded) {
        const path = `boards/.fabdesk-models/${stem}${extname(file.path)}`;
        files[path] = file.bytes;
        dependency.files.push({ path, sha256: file.sha256 });
      }
      const preferred = loaded.find((f) => f.path === resolution.path) ?? loaded[0]!;
      const target = `.fabdesk-models/${stem}${extname(preferred.path)}`;
      replacements.set(
        declared,
        "${KIPRJMOD}/" + posix.relative(posix.dirname(archiveBoard), target),
      );
      dependency.status = "packaged";
    }
    // Only rewrite model path tokens; similarly named properties and circuit content are untouched.
    const exported = text.replace(
      /(\(model\s+)"((?:\\.|[^"\\])*)"/g,
      (whole, prefix: string, value: string) => {
        const path = value.replace(/\\(.)/g, "$1");
        const replacement = replacements.get(path);
        return replacement ? prefix + JSON.stringify(replacement) : whole;
      },
    );
    files[`boards/${archiveBoard}`] = new TextEncoder().encode(exported);
    // Preserve the exact original whenever portability requires rewriting a model reference.
    if (exported !== text) files[`source-boards/${archiveBoard}`] = bytes;
  }
  return { files, dependencies, revision: hash(JSON.stringify(dependencies)) };
}
