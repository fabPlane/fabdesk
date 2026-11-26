const { execFileSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

// Keep the waiter inside app.asar even when Windows has not extracted the other
// resources yet. Electron-builder must not relocate this payload to asar.unpacked.
module.exports = function beforePack(context) {
  if (context.electronPlatformName !== "win32") return;
  const app = context.packager.info.appDir;
  const scratch = mkdtempSync(join(tmpdir(), "fabdesk-build-waiter-"));
  try {
    const binary = join(scratch, "FabDeskUpdateWaiter.exe");
    const source = join(__dirname, "update-windows-launch.cs");
    const compiler = process.platform === "win32"
      ? join(process.env.SystemRoot || "C:\\Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe")
      : "mcs";
    execFileSync(compiler, ["/nologo", "/optimize+", "/target:winexe", "/platform:anycpu", "/out:" + binary, source],
      { windowsHide: true, stdio: "pipe" });
    mkdirSync(join(app, "out", "native"), { recursive: true });
    writeFileSync(join(app, "out", "native", "update-windows-launch.b64"), readFileSync(binary).toString("base64"));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
};
