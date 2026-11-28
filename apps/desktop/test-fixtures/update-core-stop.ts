// Run in an isolated Bun process: Electron app APIs are absent from the unit runner.
import { mock, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "fabdesk-update-core-"));
mock.module("electron", () => ({ app: { getPath: () => dir } }));
const { CoreSupervisor } = await import("../src/main/core-supervisor");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: "ignore" });
let settings = 0, shutdowns = 0;
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/health") return Response.json({ pid: child.pid, runtimeId: "other", parentPid: process.pid });
  if (path === "/shutdown") { shutdowns++; child.kill(); }
  if (path === "/settings") settings++;
  return Response.json({ keepCoreRunning: true });
} });
try {
  const pid = child.pid!;
  const port = server.port!;
  const owned = new CoreSupervisor({ localAuth: true });
  Object.assign(owned, { child, pid, token: "fake", port });
  writeFileSync(join(dir, "daemon.json"), JSON.stringify({ pid, token: "fake", port }));
  const shared = new CoreSupervisor({ localAuth: true, runtimeId: "new-session" });
  const attach = shared as unknown as { tryAttach(): Promise<boolean> };
  expect(await attach.tryAttach()).toBe(false);
  await expect(shared.assertCanUpdate()).rejects.toThrow("Another FabDesk core is running");
  await expect(shared.stopForUpdate()).rejects.toThrow("Another FabDesk core is running");
  expect(shutdowns).toBe(0);
  expect(child.exitCode).toBeNull();
  // A regular quit preserves the process according to the actual /settings response.
  await owned.stop({ shutdown: true });
  expect(settings).toBe(1);
  expect(shutdowns).toBe(0);
  Object.assign(owned, { child, pid, token: "fake", port });
  await owned.stopForUpdate();
  expect(shutdowns).toBe(1);
  expect(settings).toBe(1);
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  await shared.assertCanUpdate();
} finally {
  server.stop(true);
  if (child.exitCode === null && child.signalCode === null) child.kill();
  rmSync(dir, { force: true, recursive: true });
}
