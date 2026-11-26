import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { deferWindowsUpdateLaunch } from "./update-windows-launch";

test("ordinary starts and stale or invalid receipts do not start a helper", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fabdesk-receipt-"));
  const launch = { appPath: directory, userData: directory, version: "0.4.26", cwd: directory, exe: process.execPath, args: [] };
  try {
    expect(await deferWindowsUpdateLaunch(launch)).toBe(false);
    for (const receipt of ["invalid", { version: "0.4.25" }, { version: "invalid" }, { version: "0.4.26", phase: "unknown" }]) {
      writeFileSync(join(directory, "update-install.json"), JSON.stringify(receipt));
      expect(await deferWindowsUpdateLaunch(launch)).toBe(false);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== "win32")("a real Windows installer mutex coalesces duplicate opens and forwards each distinct command", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fabdesk-launch with spaces-"));
  const mutex = "Local\\fabdesk-qa-" + randomUUID();
  const output = join(directory, "result.jsonl");
  const script = join(directory, "check.cjs");
  const argv = ["--updated", "fabplane://open?id=1&other=2", 'a"b', "with spaces\\", "", "東京"];
  writeFileSync(script, "require('node:fs').appendFileSync(process.argv[2], JSON.stringify({ args: process.argv.slice(3), cwd: process.cwd() }) + '\\n')");
  const launch = { appPath: directory, userData: directory, version: "0.4.26", cwd: directory, exe: process.execPath, args: [script, output, ...argv] };
  createRequire(import.meta.url)("../../scripts/before-pack.cjs")({ electronPlatformName: "win32", packager: { info: { appDir: directory } } });
  copyFileSync(join(directory, "out/native/update-windows-launch.b64"), join(directory, "update-windows-launch.b64"));
  const powershell = join(process.env["SystemRoot"]!, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const holder = spawn(powershell, ["-NoProfile", "-NonInteractive", "-Command",
    "$m = [Threading.Mutex]::new($true, $env:FABDESK_QA_MUTEX); [Console]::WriteLine('held'); [Console]::ReadLine() | Out-Null; $m.Dispose()"],
  { windowsHide: true, env: { ...process.env, FABDESK_QA_MUTEX: mutex }, stdio: ["pipe", "pipe", "ignore"] });
  try {
    const lines = createInterface({ input: holder.stdout });
    expect(await new Promise<string>((done, reject) => {
      lines.once("line", done);
      holder.once("error", reject);
      holder.once("exit", () => reject(new Error("Windows fixture exited before taking its mutex")));
    })).toBe("held");
    lines.close();
    for (const receipt of [{ version: "0.4.26", phase: "applying" }, { version: "0.4.26" }]) {
      writeFileSync(join(directory, "update-install.json"), JSON.stringify(receipt));
      expect(await deferWindowsUpdateLaunch(launch, mutex, holder.pid!)).toBe(true);
    }
    const other = ["fabplane://open?catalog=foostan/crkbd"];
    expect(await deferWindowsUpdateLaunch({ ...launch, args: [script, output, ...other] }, mutex, holder.pid!)).toBe(true);
    expect(existsSync(output)).toBe(false);
    holder.stdin.end("\n");
    for (let i = 0; i < 100; i++) {
      if (existsSync(output) && readFileSync(output, "utf8").trim().split("\n").length === 2) break;
      await Bun.sleep(100);
    }
    await Bun.sleep(300);
    const calls = readFileSync(output, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(calls).toHaveLength(2);
    expect(calls).toContainEqual({ args: argv, cwd: directory });
    expect(calls).toContainEqual({ args: other, cwd: directory });
    expect(await deferWindowsUpdateLaunch(launch, mutex)).toBe(false);
  } finally {
    holder.kill();
    rmSync(directory, { recursive: true, force: true });
  }
}, 25_000);
