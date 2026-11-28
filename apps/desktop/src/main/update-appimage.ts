import { createHash } from "node:crypto";
import { constants, createReadStream, lstatSync, renameSync } from "node:fs";
import { chmod, copyFile, lstat, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

/** Preserve the original launcher path, including names containing a version. Both files
 * live on the same filesystem so a failed replacement leaves the current AppImage in place. */
export async function stageAppImage(image: string, download: string, sha256: string) {
  if (!isAbsolute(image) || !/^[a-f0-9]{64}$/i.test(sha256)) throw new Error("Invalid AppImage update target.");
  const destination = await realpath(image);
  const old = await stat(destination);
  if (!old.isFile()) throw new Error("The current AppImage is unavailable.");
  const filenameId = createHash("sha256").update(basename(destination)).digest("hex").slice(0, 16);
  const path = join(dirname(destination), `.fabplane-${filenameId}-${sha256}.pending`);
  // The same approved release may already have been staged by an interrupted session.
  try { await copyFile(download, path, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.nlink !== 1) throw new Error("Invalid pending AppImage.");
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(path)) digest.update(chunk);
    if (digest.digest("hex") !== sha256) throw new Error("The staged AppImage failed verification. Retry the update.");
    await chmod(path, old.mode & 0o777);
    const { dev, ino, ctimeNs, size } = await lstat(path, { bigint: true });
    return { path, destination, dev, ino, ctimeNs, size };
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
}

export function installAppImage(staged: Awaited<ReturnType<typeof stageAppImage>>): void {
  const current = lstatSync(staged.path, { bigint: true });
  if (!current.isFile() || current.dev !== staged.dev || current.ino !== staged.ino
      || current.ctimeNs !== staged.ctimeNs || current.size !== staged.size) {
    throw new Error("The pending AppImage changed after verification.");
  }
  renameSync(staged.path, staged.destination);
}
