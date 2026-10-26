import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEV_DRIVER = join(dirname(fileURLToPath(import.meta.url)), "smlib-driver.py");

/** Python driver source shipped beside the compiled fabdesk-core binary (see apps/core/scripts/build.ts). */
export const SMLIB_DRIVER_BASENAME = "smlib-driver.py";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

let cachedMaterialized: string | null = null;

/**
 * Resolve smlib-driver.py for dev (`bun`), packaged desktop (copied next to fabdesk-core), or
 * materialize from the repo copy into the OS temp dir when only the JS bundle is present.
 */
export async function resolveSmlibDriverPath(): Promise<string> {
  const besideBinary = join(dirname(process.execPath), SMLIB_DRIVER_BASENAME);
  if (await exists(besideBinary)) return besideBinary;
  if (await exists(DEV_DRIVER)) return DEV_DRIVER;
  if (cachedMaterialized && (await exists(cachedMaterialized))) return cachedMaterialized;
  const source = await Bun.file(DEV_DRIVER).text();
  const dir = join(
    process.env["TMPDIR"] || process.env["TEMP"] || "/tmp",
    "fabdesk-smlib-driver",
  );
  await mkdir(dir, { recursive: true });
  const dest = join(dir, SMLIB_DRIVER_BASENAME);
  await writeFile(dest, source, "utf8");
  cachedMaterialized = dest;
  return dest;
}
