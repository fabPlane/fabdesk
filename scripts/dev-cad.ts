#!/usr/bin/env bun
/**
 * Launch Fabdesk in development with the FabPlane CAD bridge running from `vendor/fab_cad`.
 * FreeCAD is the fork's `FreeCADApiServer` when `FREECAD_API_SERVER` names it, else fab_cad's mock
 * server (Part primitives, undo, STL/OBJ export; no Python). The CAD tab shows the web UI when
 * `vendor/fab_cad/apps/web/dist` has been built (see docs/fab-cad.md).
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const source = resolve(process.env["FABDESK_FAB_CAD_SOURCE"] ?? join(root, "vendor", "fab_cad"));
if (!existsSync(join(source, "packages", "bridge", "src", "main.ts"))) {
  console.error(
    `No fab_cad checkout at ${source}: run \`git submodule update --init vendor/fab_cad\`.`,
  );
  process.exit(1);
}
const freecad = process.env["FREECAD_API_SERVER"]?.trim();
console.error(`[dev:cad] bridge source=${source}`);
console.error(`[dev:cad] FreeCAD=${freecad || "fab_cad mock server"}`);
if (!existsSync(join(source, "apps", "web", "dist")))
  console.error("[dev:cad] no built web UI in apps/web/dist; the CAD tab will say so");
const child = Bun.spawn(["bun", "run", "dev"], {
  cwd: root,
  env: { ...process.env, FABDESK_FAB_CAD_SOURCE: source, FABDESK_DEV_PROFILE: "1" },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
process.exit(await child.exited);
