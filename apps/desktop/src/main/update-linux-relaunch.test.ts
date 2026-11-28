import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linuxUpdateEnvironment, restartLinuxAfterUpdate } from "./update-linux-relaunch";

test("the incoming AppImage receives the desktop session without loader paths from the old mount", () => {
  const env = { APPDIR: "/tmp/old", APPIMAGE: "/apps/FabDesk", ARGV0: "fab", OWD: "/work", DISPLAY: ":2",
    FABDESK_HOME: "/home/fab", PATH: "/tmp/old/bin:/tmp/older/bin:/bin", LD_LIBRARY_PATH: "/tmp/old/lib",
    XDG_DATA_DIRS: "/usr/share:/tmp/old" };
  expect(linuxUpdateEnvironment(env)).toEqual({
    DISPLAY: ":2", FABDESK_HOME: "/home/fab", PATH: "/tmp/older/bin:/bin", XDG_DATA_DIRS: "/usr/share",
  });
  expect(env.APPDIR).toBe("/tmp/old");
});

test.skipIf(process.platform !== "linux")("the updated program starts once after exit, with literal profile arguments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fabdesk-relaunch-"));
  const launcher = join(dir, "FabDesk's test AppImage");
  const output = join(dir, "received");
  const profile = "--user-data-dir=/home/é's work/$(literal)";
  const original = spawn("/bin/cat", [], { stdio: ["pipe", "ignore", "ignore"] });
  try {
    await once(original, "spawn");
    writeFileSync(launcher, '#!/bin/sh\nprintf "%s\\n" "$2" >> "$1"\n', { mode: 0o700 });
    restartLinuxAfterUpdate(launcher, [output, profile], original.pid!);
    await Bun.sleep(300);
    expect(existsSync(output)).toBe(false);
    const exited = once(original, "exit");
    original.stdin.end();
    await exited;
    const deadline = Date.now() + 4500;
    while (!existsSync(output) && Date.now() < deadline) await Bun.sleep(25);
    expect(readFileSync(output, "utf8")).toBe(profile + "\n");
  } finally {
    original.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}, 8000);
