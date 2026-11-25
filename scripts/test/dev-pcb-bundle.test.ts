import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devPcbEnvironment, discoverPcbBundle, installedBundleCandidates } from "../dev-pcb-bundle";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function bundle(dir: string, target: string): string {
  const folder = join(dir, "resources", "pcb");
  mkdirSync(folder, { recursive: true });
  const path = join(folder, "bundle.json");
  writeFileSync(path, JSON.stringify({ format: 1, target }));
  return path;
}
function workspace(): { root: string; release: string; app: string } {
  const root = mkdtempSync(join(tmpdir(), "dev-pcb-bundle-"));
  dirs.push(root);
  return { root, release: join(root, "apps", "desktop", "release", "mac-arm64"), app: join(root, "installed") };
}
const mac = { platform: "darwin" as const, arch: "arm64" };

describe("discoverPcbBundle", () => {
  test("prefers the release folder over an installed app", async () => {
    const { root, release, app } = workspace();
    const built = bundle(release, "darwin-arm64");
    const installed = bundle(app, "darwin-arm64");
    expect(await discoverPcbBundle({ root, ...mac, installed: [installed] })).toEqual({ path: built, origin: "release" });
  });
  test("falls back to the installed app's bundle", async () => {
    const { root, app } = workspace();
    const installed = bundle(app, "darwin-arm64");
    expect(await discoverPcbBundle({ root, ...mac, installed: [installed] })).toEqual({ path: installed, origin: "installed" });
  });
  test("ignores bundles built for another platform", async () => {
    const { root, release, app } = workspace();
    bundle(release, "linux-x64");
    expect(await discoverPcbBundle({ root, ...mac, installed: [bundle(app, "windows-x64")] })).toBeNull();
  });
});

describe("devPcbEnvironment", () => {
  test("points the app at a discovered bundle", async () => {
    const { root, app } = workspace();
    const installed = bundle(app, "darwin-arm64");
    const result = await devPcbEnvironment({ root, env: {}, ...mac, installed: [installed] });
    expect(result.env).toEqual({ FABDESK_FP_PCB_BUNDLE: installed, FABDESK_DEV_PCB_DISCOVERED_BUNDLE: installed });
  });
  test("leaves an explicit backend choice or an opt-out alone", async () => {
    const { root, app } = workspace();
    const installed = [bundle(app, "darwin-arm64")];
    for (const env of [
      { FABDESK_FP_PCB_BUNDLE: "/elsewhere/bundle.json" },
      { FABDESK_FP_PCB_BRIDGE_BIN: "/elsewhere/fp-pcb-bridge" },
      { FABDESK_FP_PCB_BRIDGE_URL: "http://127.0.0.1:4020" },
      { FABDESK_DEV_PCB: "0" },
    ])
      expect((await devPcbEnvironment({ root, env, ...mac, installed })).env).toEqual({});
  });
  test("starts without a backend when none is found", async () => {
    const { root } = workspace();
    const result = await devPcbEnvironment({ root, env: {}, ...mac, installed: [] });
    expect(result.env).toEqual({});
    expect(result.note).toContain("no PCB backend bundle found");
  });
});

test("installed bundle locations follow the platform's default install", () => {
  expect(installedBundleCandidates({ platform: "darwin", env: {}, home: "/Users/dev" })).toEqual([
    "/Applications/fabPlane.app/Contents/Resources/pcb/bundle.json",
    "/Users/dev/Applications/fabPlane.app/Contents/Resources/pcb/bundle.json",
  ]);
  expect(installedBundleCandidates({ platform: "linux", env: {}, home: "/home/dev" })).toEqual(["/opt/fabPlane/resources/pcb/bundle.json"]);
});
