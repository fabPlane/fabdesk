/**
 * electron-builder afterPack hook.
 * 1. Copy a staged FabPlane KiCad tree into Resources/kicad when present
 *    (`apps/desktop/kicad-bundle/<platform>-<arch>/`, produced by `scripts/stage-kicad-bundle.ts`).
 * 2. When no signing identity is configured (public CI without certificates), macOS builds keep the
 *    Electron template's signature, which no longer matches the bundle and is refused on Apple Silicon.
 *    Re-sign ad hoc (identity "-") with our bundle id so the app launches; Gatekeeper still warns because
 *    it is not notarized, and real signing takes over automatically once CSC_LINK is provided.
 */
const { execFileSync } = require("node:child_process");
const { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } = require("node:fs");
const { join } = require("node:path");
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

function copyBundledKicad(context) {
  const src = stageRoot(context);
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
  cpSync(src, dest, { recursive: true });
  console.log(`after-pack: bundled KiCad → ${dest}`);
  return dest;
}

module.exports = async function afterPack(context) {
  copyBundledKicad(context);

  if (context.electronPlatformName !== "darwin") return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return; // real signing will run
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = join(context.appOutDir, appName);
  if (!existsSync(appPath)) {
    console.warn(`after-pack: ${appPath} not found, skipping ad-hoc signing`);
    return;
  }
  const bundleId = context.packager.appInfo.id ?? "com.tensorfleet.fabdesk";
  const entitlements = join(__dirname, "..", "build", "entitlements.mac.plist");
  console.log(`after-pack: ad-hoc signing ${appName} as ${bundleId}`);
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
