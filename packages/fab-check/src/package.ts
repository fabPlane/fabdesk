import { readZipEntries } from "./zip";
import { classifyFile, isBomName, isPosName } from "./classify";
import type { ClassifiedFile, PackageFile } from "./types";

export type LoadedPackage = {
  source: string;
  files: PackageFile[];
  classified: ClassifiedFile[];
  bomCsv?: string;
  posCsv?: string;
};

export function loadPackageFromFiles(
  files: readonly PackageFile[],
  source = "memory",
): LoadedPackage {
  const classified = files
    .filter((f) => !f.name.endsWith("/"))
    .map((f) => classifyFile(f));
  const bom = files.find((f) => isBomName(f.name));
  const pos = files.find((f) => isPosName(f.name));
  return {
    source,
    files: [...files],
    classified,
    ...(bom ? { bomCsv: new TextDecoder().decode(bom.bytes) } : {}),
    ...(pos ? { posCsv: new TextDecoder().decode(pos.bytes) } : {}),
  };
}

export function loadPackageFromZip(bytes: Uint8Array, source = "zip"): LoadedPackage {
  return loadPackageFromFiles(readZipEntries(bytes), source);
}

export async function loadPackageFromDir(dir: string, source = dir): Promise<LoadedPackage> {
  const files: PackageFile[] = [];
  await walk(dir, dir, files);
  return loadPackageFromFiles(files, source);
}

async function walk(root: string, current: string, out: PackageFile[]): Promise<void> {
  const { readdir } = await import("node:fs/promises");
  const { join, relative } = await import("node:path");
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const abs = join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(root, abs, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const bytes = new Uint8Array(await Bun.file(abs).arrayBuffer());
    out.push({ name: relative(root, abs).replace(/\\/g, "/"), bytes });
  }
}
