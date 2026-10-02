#!/usr/bin/env bun
/** Separate runtime artifact, never a main-app resource. Public upload is a distinct approved step. */
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  CAD_BRIDGE_COMMIT,
  CAD_FREECAD_COMMIT,
  CAD_RELEASE,
  CAD_REPOSITORY,
} from "../apps/desktop/src/main/cad-runtime";
const source = resolve(process.argv[2] ?? "dist/cad/darwin-arm64"),
  output = resolve(process.argv[3] ?? "dist/cad-runtime");
const candidate = process.argv.includes("--unsigned-candidate");
const app = join(output, "CADRuntime.app"),
  resources = join(app, "Contents", "Resources", "cad");
await mkdir(output, { recursive: true });
await rm(app, { recursive: true, force: true });
await cp(source, resources, { recursive: true, verbatimSymlinks: true });
const manifest = JSON.parse(await readFile(join(resources, "bundle.json"), "utf8"));
if (
  manifest.freecadCommit !== CAD_FREECAD_COMMIT ||
  manifest.target !== "darwin-arm64" ||
  manifest.engine !== "native" ||
  manifest.fabCadCommit !== CAD_BRIDGE_COMMIT
)
  throw new Error("Runtime input differs from pinned native API engine");

await mkdir(join(app, "Contents", "MacOS"));
await cp(
  join(resources, manifest.freecadApiServer),
  join(app, "Contents", "MacOS", "FreeCADApiServer"),
);
await writeFile(
  join(app, "Contents", "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.tensorfleet.fabdesk.cad-runtime</string><key>CFBundleName</key><string>FabPlane CAD Runtime</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleExecutable</key><string>FreeCADApiServer</string><key>CFBundleVersion</key><string>1.0.0</string><key>CFBundleShortVersionString</key><string>1.0.0</string><key>LSMinimumSystemVersion</key><string>15.0</string></dict></plist>`,
);
function run(args: string[]) {
  const p = Bun.spawnSync(args, { stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) throw new Error(`${args[0]} failed (${p.exitCode})`);
}
// The container's main executable lives above Resources; relocate its direct loader paths.
// The managed API process still launches the original executable beside its modules.
const topExecutable = join(app, "Contents", "MacOS", "FreeCADApiServer");
const links = Bun.spawnSync(["/usr/bin/otool", "-L", topExecutable]);
if (links.exitCode) throw new Error("Cannot inspect runtime container executable");
for (const line of links.stdout.toString().split("\n").slice(1)) {
  const dependency = line.trim().split(" (", 1)[0];
  if (dependency?.startsWith("@loader_path/../"))
    run([
      "/usr/bin/install_name_tool",
      "-change",
      dependency,
      dependency.replace("@loader_path/../", "@loader_path/../Resources/cad/freecad/"),
      topExecutable,
    ]);
}
if (!candidate) {
  // Uses the exact existing desktop signing secrets and electron-builder temporary-keychain helper.
  const required = [
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
  ];
  for (const name of required)
    if (!process.env[name])
      throw new Error(`${name} is required; unsigned runtime publishing is forbidden`);
  if (process.env.APPLE_TEAM_ID !== "CMNZZ92926")
    throw new Error("Signing team does not match desktop trust policy");
  run([process.execPath, "scripts/sign-cad-runtime.cjs", app]);
  const { verifyCadMacApp } = await import("../apps/desktop/src/main/cad-runtime-mac");
  await verifyCadMacApp(app);
}
const archive = join(
  output,
  candidate ? "candidate-UNSIGNED-darwin-arm64.zip" : "cad-runtime-darwin-arm64.zip",
);
await rm(archive, { force: true });
run(["/usr/bin/ditto", "-c", "-k", "--keepParent", app, archive]);
// Calculate ZIP's advertised uncompressed byte count, including resource metadata, on the build Mac.
const measured = Bun.spawnSync([
  "python3",
  "-c",
  "import json,os,sys,zipfile; p=sys.argv[1]; z=zipfile.ZipFile(p); print(json.dumps({'downloadBytes':os.path.getsize(p),'installedBytes':sum(i.file_size for i in z.infolist())}))",
  archive,
]);
if (measured.exitCode) throw new Error("Could not measure runtime artifact");
const sizes = JSON.parse(measured.stdout.toString());
const { validateCadArchive } = await import("../apps/desktop/src/main/cad-runtime-archive");
await validateCadArchive(archive, sizes.installedBytes);
const hash = new Bun.CryptoHasher("sha256");
for await (const chunk of Bun.file(archive).stream()) hash.update(chunk);
const base = `https://github.com/${CAD_REPOSITORY}/releases/download/${CAD_RELEASE}/`;
await cp(join(resources, "freecad", "licenses", "NOTICE.txt"), join(output, "NOTICE.txt"));
run([
  "tar",
  "-czf",
  join(output, "cad-runtime-sources.tar.gz"),
  "-C",
  join(resources, "freecad"),
  "sources",
  "licenses",
  "build-recipe.json",
]);
async function fileHash(path: string): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}
const catalog = {
  format: 1,
  version: CAD_RELEASE,
  target: "darwin-arm64",
  minimumOS: "15.0",
  ...sizes,
  sha256: hash.digest("hex"),
  url: base + "cad-runtime-darwin-arm64.zip",
  freecadCommit: CAD_FREECAD_COMMIT,
  fabCadCommit: CAD_BRIDGE_COMMIT,
  sourceUrl: `https://github.com/${CAD_REPOSITORY}/releases/tag/${CAD_RELEASE}`,
  sourcesUrl: base + "cad-runtime-sources.tar.gz",
  licensesUrl: base + "NOTICE.txt",
  licensesSha256: await fileHash(join(output, "NOTICE.txt")),
  sourcesSha256: await fileHash(join(output, "cad-runtime-sources.tar.gz")),
};
await writeFile(
  join(output, candidate ? "candidate-UNSIGNED-measurements.json" : "manifest-darwin-arm64.json"),
  JSON.stringify(catalog, null, 2) + "\n",
);
console.log(
  JSON.stringify({ ...sizes, signedAndNotarized: !candidate, archive, published: false }),
);
