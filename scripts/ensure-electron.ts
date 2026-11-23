/** Bun can reuse a cached Electron package whose install hook never downloaded its runtime. */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { access, readFile } from "node:fs/promises";

export async function ensureElectron(): Promise<void> {
  if (process.env["FABDESK_SKIP_ELECTRON_INSTALL"] === "1") return;
  const root = dirname(createRequire(import.meta.url).resolve("electron/package.json"));
  const installed = async () => {
    try { const path = (await readFile(join(root, "path.txt"), "utf8")).trim(); await access(join(root, "dist", path)); return Boolean(path); }
    catch { return false; }
  };
  if (await installed()) return;
  const child = Bun.spawn([process.execPath, join(root, "install.js")], { stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0 || !await installed()) throw Error("Electron runtime install failed; rerun bun run desktop:install after correcting the download error.");
}
if (import.meta.main) await ensureElectron();
