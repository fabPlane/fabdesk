import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { CAD_BRIDGE_COMMIT, CAD_FREECAD_COMMIT, CAD_TEAM } from "./cad-runtime";
import { validateCadArchive } from "./cad-runtime-archive";
const exec = promisify(execFile);
// Parentheses make codesign -R parse an expression. A bare string is opened as a file.
export const CAD_MAC_REQUIREMENT = `(anchor apple generic and certificate leaf[subject.OU] = "${CAD_TEAM}" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists)`;
async function command(bin: string, args: string[]): Promise<void> {
  await exec(bin, args, { timeout: 120_000, maxBuffer: 1024 * 1024 });
}
export async function verifyCadMacApp(app: string): Promise<string> {
  if ((await lstat(app)).isSymbolicLink()) throw new Error("CAD runtime app must not be an alias");
  const root = await realpath(app);
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const rel = relative(root, await realpath(p));
        if (rel.startsWith("..") || isAbsolute(rel))
          throw new Error("CAD runtime link escapes signed app");
      } else if (entry.isDirectory()) await walk(p);
      else if (!entry.isFile()) throw new Error("Unsupported runtime file");
    }
  }
  await walk(root);
  await command("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "-R",
    CAD_MAC_REQUIREMENT,
    root,
  ]);
  await command("/usr/bin/xcrun", ["stapler", "validate", root]);
  await command("/usr/sbin/spctl", ["--assess", "--type", "execute", root]);
  const path = join(root, "Contents", "Resources", "cad", "bundle.json");
  const m = JSON.parse(await readFile(path, "utf8"));
  if (
    m.format !== 1 ||
    m.engine !== "native" ||
    m.target !== "darwin-arm64" ||
    m.freecadCommit !== CAD_FREECAD_COMMIT ||
    m.fabCadCommit !== CAD_BRIDGE_COMMIT
  )
    throw new Error("Installed FreeCAD API engine is incompatible");
  for (const p of [
    m.bridge,
    m.freecadApiServer,
    m.web,
    m.pythonHome,
    ...(m.libraryPaths ?? []),
    ...Object.values(m.environmentPaths ?? {}),
  ]) {
    if (typeof p !== "string" || isAbsolute(p) || p.includes("\\") || p.split("/").includes(".."))
      throw new Error("Unsafe installed runtime path");
    const rel = relative(root, await realpath(join(root, "Contents", "Resources", "cad", p)));
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new Error("Installed runtime path escapes signed app");
  }
  return path;
}
export async function unpackCadMacApp(
  zip: string,
  directory: string,
  installedBytes: number,
): Promise<void> {
  await validateCadArchive(zip, installedBytes);
  // Preserve OS provenance and assess it; never remove quarantine or disable Gatekeeper.
  const quarantine = `0081;${Math.floor(Date.now() / 1000).toString(16)};fabPlane;`;
  await command("/usr/bin/xattr", ["-w", "com.apple.quarantine", quarantine, zip]);
  await command("/usr/bin/ditto", ["-x", "-k", zip, directory]);
  await command("/usr/bin/xattr", [
    "-w",
    "com.apple.quarantine",
    quarantine,
    join(directory, "CADRuntime.app"),
  ]);
}
