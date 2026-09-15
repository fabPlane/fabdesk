#!/usr/bin/env bun
/** Launch Fabdesk in development with a previously downloaded or packaged PCB backend bundle. */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const expectedTarget = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;

async function findBundles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await findBundles(path)));
    else if (entry.name === "bundle.json" && /[\\/]resources[\\/]pcb[\\/]bundle\.json$/.test(path))
      found.push(path);
  }
  return found;
}

async function bundleTarget(path: string): Promise<string | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { format?: number; target?: string };
    return value.format === 1 && typeof value.target === "string" ? value.target : null;
  } catch {
    return null;
  }
}

let bundle = process.env["FABDESK_FP_PCB_BUNDLE"]?.trim();
if (bundle) bundle = resolve(bundle);
else {
  const candidates = await findBundles(join(root, "apps", "desktop", "release"));
  for (const candidate of candidates) {
    if ((await bundleTarget(candidate)) === expectedTarget) {
      bundle = candidate;
      break;
    }
  }
}

if (!bundle || !existsSync(bundle)) {
  console.error(
    `No ${expectedTarget} FabPlane PCB backend bundle found. Set FABDESK_FP_PCB_BUNDLE=/absolute/path/to/bundle.json or package/download the backend first.`,
  );
  process.exit(1);
}

console.error(`[dev:pcb] backend=${bundle}`);
if (process.env["FABDESK_FP_PCB_SOURCE"])
  console.error(`[dev:pcb] bridge source=${resolve(process.env["FABDESK_FP_PCB_SOURCE"]!)}`);
const child = Bun.spawn(["bun", "run", "dev"], {
  cwd: root,
  env: { ...process.env, FABDESK_FP_PCB_BUNDLE: bundle, FABDESK_DEV_PROFILE: "1" },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
process.exit(await child.exited);
