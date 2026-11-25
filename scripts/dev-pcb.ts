#!/usr/bin/env bun
/** Launch Fabdesk in development with a previously downloaded or packaged PCB backend bundle. */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { bundleTargetFor, discoverPcbBundle } from "./dev-pcb-bundle";

const root = resolve(import.meta.dir, "..");
const expectedTarget = bundleTargetFor(process.platform, process.arch);

const configuredBundle = process.env["FABDESK_FP_PCB_BUNDLE"]?.trim();
const bundle = configuredBundle
  ? resolve(configuredBundle)
  : (await discoverPcbBundle({ root }))?.path;

if (!bundle || !existsSync(bundle)) {
  console.error(
    `No ${expectedTarget} FabPlane PCB backend bundle found. Set FABDESK_FP_PCB_BUNDLE=/absolute/path/to/bundle.json, install fabPlane, or package/download the backend first.`,
  );
  process.exit(1);
}

console.error(`[dev:pcb] backend=${bundle}`);
if (process.env["FABDESK_FP_PCB_SOURCE"])
  console.error(`[dev:pcb] bridge source=${resolve(process.env["FABDESK_FP_PCB_SOURCE"]!)}`);
const child = Bun.spawn(["bun", "run", "dev"], {
  cwd: root,
  env: {
    ...process.env,
    FABDESK_FP_PCB_BUNDLE: bundle,
    FABDESK_DEV_PCB_DISCOVERED_BUNDLE: configuredBundle ? "" : bundle,
    FABDESK_DEV_PROFILE: "1",
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
process.exit(await child.exited);
