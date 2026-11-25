#!/usr/bin/env bun
/**
 * `bun run dev`: the desktop app in development, with the PCB backend started when a bundle for
 * this platform can be found (see dev-pcb-bundle.ts), so board editing and routing work without
 * extra setup. `FABDESK_DEV_PCB=0` skips it.
 */
import { resolve } from "node:path";
import { devPcbEnvironment } from "./dev-pcb-bundle";

const root = resolve(import.meta.dir, "..");
const pcb = await devPcbEnvironment({ root, env: process.env });
console.error(`[dev] ${pcb.note}`);
const child = Bun.spawn(["bun", "run", "--cwd", "apps/desktop", "dev"], {
  cwd: root,
  env: { ...process.env, ...pcb.env },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
process.exit(await child.exited);
