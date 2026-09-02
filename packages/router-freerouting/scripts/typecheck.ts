#!/usr/bin/env bun
/** Typechecks only when vendor/js_autorouter is checked out (internal builds); public checkouts skip. */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const vendor = join(pkg, "..", "..", "vendor", "js_autorouter", "src");
if (!existsSync(vendor)) {
  console.log("router-freerouting typecheck skipped: vendor/js_autorouter is not initialized (public build)");
  process.exit(0);
}
const proc = Bun.spawnSync(["bunx", "tsc", "--noEmit", "-p", pkg], { stdout: "inherit", stderr: "inherit" });
process.exit(proc.exitCode ?? 1);
