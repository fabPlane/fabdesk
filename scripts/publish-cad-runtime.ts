#!/usr/bin/env bun
/** Explicitly approved maintainer step; never called by normal release or CI. */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CAD_RELEASE,
  CAD_REPOSITORY,
  validateCadManifest,
} from "../apps/desktop/src/main/cad-runtime";
import { unpackCadMacApp, verifyCadMacApp } from "../apps/desktop/src/main/cad-runtime-mac";
if (!process.argv.includes(`--approved-public-release=${CAD_RELEASE}`))
  throw new Error(
    "User approval for this exact public runtime release is required before publishing",
  );
if (process.platform !== "darwin")
  throw new Error("A Mac must verify the signed runtime before publication");
const dir = resolve(process.argv[2] ?? "");
function run(args: string[]) {
  const p = Bun.spawnSync(args, { stderr: "inherit" });
  if (p.exitCode) throw new Error(`${args[0]} failed`);
  return p.stdout.toString();
}
const repo = JSON.parse(run(["gh", "api", `repos/${CAD_REPOSITORY}`]));
if (repo.full_name !== CAD_REPOSITORY || repo.private || repo.visibility !== "public")
  throw new Error(
    "Expected existing public FreeCAD repository; no permissions or visibility will be changed",
  );
const existing = Bun.spawnSync(["gh", "release", "view", CAD_RELEASE, "--repo", CAD_REPOSITORY], {
  stdout: "ignore",
  stderr: "ignore",
});
if (!existing.exitCode)
  throw new Error("Release already exists; refusing to replace immutable runtime assets");
const catalog = validateCadManifest(
  JSON.parse(await readFile(join(dir, "manifest-darwin-arm64.json"), "utf8")),
);
const zip = join(dir, "cad-runtime-darwin-arm64.zip");
if ((await stat(zip)).size !== catalog.downloadBytes) throw new Error("Runtime size mismatch");
const hash = new Bun.CryptoHasher("sha256");
for await (const chunk of Bun.file(zip).stream()) hash.update(chunk);
if (hash.digest("hex") !== catalog.sha256) throw new Error("Runtime checksum mismatch");
for (const name of ["NOTICE.txt", "cad-runtime-sources.tar.gz"])
  if (!(await stat(join(dir, name))).size) throw new Error(`Missing license/source asset: ${name}`);
for (const [name, expected] of [
  ["NOTICE.txt", catalog.licensesSha256],
  ["cad-runtime-sources.tar.gz", catalog.sourcesSha256],
]) {
  const hash = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(join(dir, name!)).stream()) hash.update(chunk);
  if (hash.digest("hex") !== expected) throw new Error(`Source/license checksum mismatch: ${name}`);
}
const temp = await mkdtemp(join(tmpdir(), "cad-public-review-"));
try {
  await unpackCadMacApp(zip, temp, catalog.installedBytes);
  await verifyCadMacApp(join(temp, "CADRuntime.app"));
} finally {
  await rm(temp, { recursive: true, force: true });
}
run([
  "gh",
  "release",
  "create",
  CAD_RELEASE,
  zip,
  join(dir, "manifest-darwin-arm64.json"),
  join(dir, "NOTICE.txt"),
  join(dir, "cad-runtime-sources.tar.gz"),
  "--repo",
  CAD_REPOSITORY,
  "--target",
  catalog.freecadCommit,
  "--title",
  `Optional CAD runtime ${CAD_RELEASE}`,
  "--notes",
  `macOS ARM64, macOS 15+. API fork ${catalog.freecadCommit}; bridge/viewer ${catalog.fabCadCommit}. Download ${catalog.downloadBytes} bytes; installed ${catalog.installedBytes} bytes. SHA-256 ${catalog.sha256}. Corresponding sources and license notices are attached and included in the signed runtime.`,
  "--latest=false",
]);
