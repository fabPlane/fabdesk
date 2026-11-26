/**
 * electron-builder afterPack hook.
 * 1. Copy a staged FabPlane KiCad tree into Resources/kicad when present
 *    (`apps/desktop/kicad-bundle/<platform>-<arch>/`, produced by `scripts/stage-kicad-bundle.ts`).
 *    Refresh the Mac PCB backend's KiCad copy too, after checking its exact API source pin.
 * 2. When no signing identity is configured (public CI without certificates), macOS builds keep the
 *    Electron template's signature, which no longer matches the bundle and is refused on Apple Silicon.
 *    Re-sign ad hoc (identity "-") with our bundle id so the app launches; Gatekeeper still warns because
 *    it is not notarized, and real signing takes over automatically once CSC_LINK is provided.
 * 3. Make every file in the macOS bundle owner-writable. Squirrel.Mac strips the quarantine
 *    attribute from each file of an update, which fails on a read-only one ("Permission denied");
 *    it then gives up after three attempts and the in-place update never applies. The bundled
 *    Java runtime ships its legal notices read-only.
 */
const { execFileSync } = require("node:child_process");
const {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} = require("node:fs");
const { join, relative } = require("node:path");
const { Arch } = require("builder-util");

function platformArch(context) {
  const platform = context.electronPlatformName; // darwin | linux | win32
  const arch = context.arch === Arch.arm64 || context.arch === "arm64" ? "arm64" : "x64";
  if (platform === "darwin")
    return {
      dir: `darwin-${arch}`,
      resources: join(
        context.appOutDir,
        `${context.packager.appInfo.productFilename}.app`,
        "Contents",
        "Resources",
      ),
    };
  if (platform === "win32")
    return { dir: `windows-${arch}`, resources: join(context.appOutDir, "resources") };
  return { dir: `linux-${arch}`, resources: join(context.appOutDir, "resources") };
}

function stageRoot(context) {
  return join(__dirname, "..", "kicad-bundle", platformArch(context).dir);
}

function refreshMacPcbKicad(context, src, resources) {
  if (context.electronPlatformName !== "darwin") return;
  const manifestPath = join(resources, "pcb", "bundle.json");
  if (!existsSync(manifestPath)) return;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    manifest.format !== 1 ||
    manifest.target !== platformArch(context).dir ||
    manifest.kicadCli !== "kicad/kicad-cli" ||
    manifest.stockData !== "kicad/KiCad.app/Contents/SharedSupport"
  )
    throw new Error("after-pack: unsupported Mac PCB KiCad layout or target");
  const backend = join(resources, "pcb", "kicad");
  const sourceCommit = readFileSync(join(src, "KICAD_COMMIT"), "utf8").trim();
  const apiCommit = readFileSync(join(backend, "KICAD_COMMIT"), "utf8").trim();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit) || sourceCommit !== apiCommit)
    throw new Error(`after-pack: KiCad source ${sourceCommit} does not match PCB API ${apiCommit}`);
  for (const loader of ["oce", "vrml", "idf"])
    if (!existsSync(join(src, "KiCad.app/Contents/PlugIns/3d", `libs3d_plugin_${loader}.so`)))
      throw new Error(`after-pack: staged KiCad is missing the ${loader} model loader`);
  rmSync(backend, { recursive: true, force: true });
  cpSync(src, backend, { recursive: true, verbatimSymlinks: true });
  console.log(`after-pack: refreshed PCB KiCad at API source ${sourceCommit} → ${backend}`);
}

function copyBundledKicad(context, src = stageRoot(context)) {
  if (!existsSync(src) || !statSync(src).isDirectory()) {
    const message = `after-pack: no staged KiCad at ${src} (run scripts/stage-kicad-bundle.ts before packaging)`;
    if (process.env.FABDESK_REQUIRE_KICAD_BUNDLE === "true") throw new Error(message);
    console.warn(message);
    return null;
  }
  const entries = readdirSync(src).filter((n) => n !== ".gitkeep" && n !== "README.md");
  if (entries.length === 0) {
    const message = `after-pack: staged KiCad dir ${src} is empty`;
    if (process.env.FABDESK_REQUIRE_KICAD_BUNDLE === "true") throw new Error(message);
    console.warn(message);
    return null;
  }
  const { resources } = platformArch(context);
  const dest = join(resources, "kicad");
  mkdirSync(resources, { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
  refreshMacPcbKicad(context, src, resources);
  console.log(`after-pack: bundled KiCad → ${dest}`);
  return dest;
}

function jreSigningBinaries(appPath) {
  const root = join(appPath, "Contents", "Resources", "pcb", "freerouting", "jre");
  if (!existsSync(root)) return [];
  const binaries = [];
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && (entry.name.endsWith(".dylib") || path === join(root, "bin", "java")))
        binaries.push(relative(appPath, path));
    }
  }
  visit(root);
  return binaries;
}

/** --deep can preserve an existing Bun signature without applying our JIT entitlements. */
function signAdHocSidecars(appPath, binaries, entitlements, run = execFileSync) {
  for (const binary of binaries) {
    const path = join(appPath, binary);
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    run(
      "codesign",
      ["--force", "--sign", "-", "--entitlements", entitlements, "--options", "runtime", path],
      { stdio: "inherit" },
    );
  }
}

/** Adds owner write to every file and folder under `root` that lacks it; returns how many changed. */
function makeOwnerWritable(root) {
  let changed = 0;
  const visit = (path) => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return;
    if ((info.mode & 0o200) === 0) {
      chmodSync(path, (info.mode & 0o7777) | 0o200);
      changed += 1;
    }
    if (info.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
  };
  visit(root);
  return changed;
}

module.exports = async function afterPack(context) {
  copyBundledKicad(context);

  if (context.electronPlatformName !== "darwin") return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = join(context.appOutDir, appName);
  if (!existsSync(appPath)) {
    console.warn(`after-pack: ${appPath} not found, skipping ad-hoc signing`);
    return;
  }
  // electron-builder's binaries list takes literal paths, not globs. Enumerate all JRE
  // dylibs (including lib/server/libjvm.dylib) before its hardened-runtime signing step.
  const madeWritable = makeOwnerWritable(appPath);
  if (madeWritable > 0) console.log(`after-pack: made ${madeWritable} read-only bundle entries owner-writable`);
  const jreBinaries = jreSigningBinaries(appPath);
  const options = context.packager.platformSpecificBuildOptions;
  options.binaries = [...new Set([...(options.binaries ?? []), ...jreBinaries])];
  if (process.env.CSC_LINK || process.env.CSC_NAME) return; // real signing will run with this list
  const bundleId = context.packager.appInfo.id ?? "com.tensorfleet.fabdesk";
  const entitlements = join(__dirname, "..", "build", "entitlements.mac.plist");
  console.log(`after-pack: ad-hoc signing ${appName} as ${bundleId}`);
  signAdHocSidecars(appPath, options.binaries, entitlements);
  execFileSync(
    "codesign",
    [
      "--force",
      "--deep",
      "--sign",
      "-",
      "--identifier",
      bundleId,
      "--entitlements",
      entitlements,
      "--options",
      "runtime",
      appPath,
    ],
    { stdio: "inherit" },
  );
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
};

module.exports.platformArch = platformArch;
module.exports.copyBundledKicad = copyBundledKicad;
module.exports.jreSigningBinaries = jreSigningBinaries;
module.exports.makeOwnerWritable = makeOwnerWritable;
module.exports.signAdHocSidecars = signAdHocSidecars;
