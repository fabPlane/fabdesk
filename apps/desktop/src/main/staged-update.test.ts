import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveAcceptedUpdate, StagedUpdate, type StagedUpdateHost, type UpdateOffer } from "./staged-update";
import { installAppImage, stageAppImage } from "./update-appimage";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fabdesk-upgrade-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const sha256 = "b".repeat(64);
test("a staged update drains a kept owned core and refuses to stop a separate live core", async () => {
  await promisify(execFile)(process.execPath, [join(import.meta.dir, "../../test-fixtures/update-core-stop.ts")], { windowsHide: true, timeout: 10_000 });
});

function setup() {
  const recordPath = join(dir, "update-install.json");
  const url = "https://example.test/asset.exe";
  const offer: UpdateOffer = { version: "2.0.0",
    asset: { filename: "asset.exe", platform: "win32", arch: "x64", kind: "exe", url, size: 12, sha256 },
    info: { version: "2.0.0", releaseDate: "2026-11-26", path: url, files: [{ url, size: 12, sha2: sha256 }] },
  };
  const events: string[] = [];
  const installs: boolean[] = [];
  const host: StagedUpdateHost = {
    recordPath, version: "1.0.0", offer: async () => offer,
    stage: async (_offer, _signal, _progress, verifying) => { verifying(); return "ready"; },
    notify: s => { events.push(s.state); }, quit: () => {}, install: (_job, restart) => { installs.push(restart); },
  };
  return { job: new StagedUpdate(host), host, offer, events, installs, recordPath };
}

test("one click stages verified bytes and a normal exit installs once without relaunch", async () => {
  const { job, events, installs, recordPath } = setup();
  const first = job.download();
  expect(job.download()).toBe(first);
  expect(await first).toMatchObject({ state: "done", restart: true });
  expect(events).toEqual(["downloading", "verifying", "done"]);
  expect(installs).toEqual([]);
  job.beforeQuit();
  job.finishQuit(1);
  expect(installs).toEqual([]);
  job.beforeQuit();
  job.finishQuit(0);
  job.finishQuit(0);
  expect(installs).toEqual([false]);
  expect(JSON.parse(readFileSync(recordPath, "utf8"))).toEqual({ phase: "applying", version: "2.0.0", sha256 });
});

test("an optional restart can be vetoed and a later normal quit stays closed", async () => {
  const { job, host, installs } = setup();
  await job.download();
  host.quit = () => job.beforeQuit(); // A renderer veto prevents the terminal quit event.
  await job.open();
  expect(installs).toEqual([]);
  job.beforeQuit();
  job.finishQuit(0);
  expect(installs).toEqual([false]);
});

test("an explicit restart requests one relaunch only after confirmed closure", async () => {
  const { job, host, installs } = setup();
  await job.download();
  host.quit = () => { job.beforeQuit(); job.finishQuit(0); };
  await job.open();
  expect(installs).toEqual([true]);
});

test("an interrupted acceptance is restored only for the exact release digest", async () => {
  const { host, recordPath, job, offer } = setup();
  saveAcceptedUpdate(recordPath, { version: offer.version, sha256 });
  await job.restore();
  expect(job.state().state).toBe("done");
  offer.asset.sha256 = "f".repeat(64);
  const changed = new StagedUpdate(host);
  await changed.restore();
  expect(changed.state().state).toBe("idle");
  expect(existsSync(recordPath)).toBe(false);
});

test("legacy update-install records surface a retry only when their target is newer", async () => {
  const { job, host, recordPath } = setup();
  writeFileSync(recordPath, JSON.stringify({ version: "2.0.0" }));
  await job.restore();
  expect(job.state()).toMatchObject({ state: "error", version: "2.0.0" });
  host.version = "2.0.0";
  const upgraded = new StagedUpdate(host);
  await upgraded.restore();
  expect(upgraded.state().state).toBe("idle");
  expect(existsSync(recordPath)).toBe(false);
});

test("a failure is retryable, and a confirmed installation never opens an installer or retries in a loop", async () => {
  const { job, host, installs, recordPath } = setup();
  const original = host.stage;
  host.stage = async () => { throw new Error("Signature mismatch"); };
  expect(await job.download()).toMatchObject({ state: "error", message: "Signature mismatch" });
  expect(existsSync(recordPath)).toBe(false);
  job.finishQuit(0);
  expect(installs).toEqual([]);
  host.stage = original;
  await job.download();
  job.finishQuit(0);
  const next = new StagedUpdate(host);
  await next.restore();
  expect(next.state().state).toBe("error");
  expect(await next.download()).toMatchObject({ state: "done" });
  host.version = "2.0.1";
  await new StagedUpdate(host).restore();
  expect(existsSync(recordPath)).toBe(false);
});

test("canceling during the download clears acceptance and prevents a late completion", async () => {
  const { job, host, recordPath, installs } = setup();
  const started = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<string>();
  host.stage = () => { started.resolve(); return complete.promise; };
  const run = job.download();
  await started.promise;
  job.cancel();
  complete.resolve("late-result");
  await run;
  job.finishQuit(0);
  expect(job.state().state).toBe("idle");
  expect(installs).toEqual([]);
  expect(existsSync(recordPath)).toBe(false);
});

test("AppImage staging preserves a versioned original filename and refuses corrupted bytes", async () => {
  const image = join(dir, "fabplane-1.0.0.AppImage");
  const download = join(dir, "fabplane-2.0.0.AppImage");
  const expected = createHash("sha256").update("new image").digest("hex");
  writeFileSync(image, "old image");
  writeFileSync(download, "bad image");
  await expect(stageAppImage(image, download, expected)).rejects.toThrow("verification");
  expect(readFileSync(image, "utf8")).toBe("old image");
  writeFileSync(download, "new image");
  const staged = await stageAppImage(image, download, expected);
  writeFileSync(staged.path, "corrupt after stage");
  expect(() => installAppImage(staged)).toThrow("changed");
  expect(readFileSync(image, "utf8")).toBe("old image");
  rmSync(staged.path);
  const retry = await stageAppImage(image, download, expected);
  installAppImage(retry);
  expect(readFileSync(image, "utf8")).toBe("new image");
  expect(existsSync(staged.path)).toBe(false);
});
