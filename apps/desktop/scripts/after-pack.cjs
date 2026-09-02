/**
 * electron-builder afterPack hook.
 * When no signing identity is configured (public CI without certificates), macOS builds keep the
 * Electron template's signature, which no longer matches the bundle and is refused on Apple Silicon.
 * Re-sign ad hoc (identity "-") with our bundle id so the app launches; Gatekeeper still warns because
 * it is not notarized, and real signing takes over automatically once CSC_LINK is provided.
 */
const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

module.exports = async function afterPack(context) {
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
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", "--identifier", bundleId, "--entitlements", entitlements, "--options", "runtime", appPath], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
};
