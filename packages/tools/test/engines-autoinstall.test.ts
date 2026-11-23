/**
 * Engines install themselves: the pinned uv bootstrap (fake archive, no network), the registry's `ensure` (one shared
 * install, progress lines, overrides never installed over, the opt-out, no automatic retry of a failure) and the
 * `board_engines` tool. No network, no Python.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { layout } from "@fabdesk/board-workflow";
import { defaultRouterCatalog, type RouterCatalogEntry } from "../src/routers/catalog";
import { KRT_VERSION } from "../src/routers/krt";
import { createRouterRegistry, type RouterRegistrySettings } from "../src/routers/registry";
import { UV_ASSETS, UV_VERSION, bootstrapUv, bootstrappedUvPath, uvAsset } from "../src/routers/uv";
import { createRegistry } from "../src/tools";
import { mockServices } from "./mock-services";

const servers: Array<{ stop(): void }> = [];
afterAll(() => {
  for (const server of servers) server.stop();
});

const touch = (path: string, body = "") => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
};

describe("pinned uv", () => {
  test("one sha256-pinned asset per supported OS/arch, from the uv release", () => {
    expect(UV_VERSION).toBe("0.13.6");
    expect(Object.keys(UV_ASSETS).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]);
    for (const a of Object.values(UV_ASSETS)) {
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.bytes).toBeGreaterThan(10_000_000);
    }
    expect(uvAsset("linux", "x64")).toMatchObject({ filename: "uv-x86_64-unknown-linux-musl.tar.gz", url: "https://github.com/astral-sh/uv/releases/download/0.13.6/uv-x86_64-unknown-linux-musl.tar.gz" });
    expect(uvAsset("linux", "arm64")?.target).toBe("aarch64-unknown-linux-musl");
    expect(uvAsset("win32", "arm64")).toMatchObject({ format: "zip", filename: "uv-aarch64-pc-windows-msvc.zip" });
    expect(uvAsset("darwin", "x64")?.target).toBe("x86_64-apple-darwin");
    expect(uvAsset("freebsd", "x64")).toBeNull();
    expect(uvAsset("linux", "ia32")).toBeNull();
  });

  test("bootstrap: download, verify, extract once; concurrent callers share it; a bad hash leaves nothing", async () => {
    const work = await mkdtemp(join(tmpdir(), "fabdesk-uv-"));
    touch(join(work, "src", "uv-x86_64-unknown-linux-musl", "uv"), "#!/bin/sh\necho uv 0.13.6\n");
    touch(join(work, "src", "uv-x86_64-unknown-linux-musl", "uvx"), "");
    const tgz = join(work, "uv.tar.gz");
    expect(Bun.spawnSync(["tar", "-czf", tgz, "-C", join(work, "src"), "uv-x86_64-unknown-linux-musl"]).exitCode).toBe(0);
    const body = await readFile(tgz);
    const sha256 = createHash("sha256").update(body).digest("hex");
    let hits = 0;
    const server = Bun.serve({ port: 0, fetch: () => (hits++, new Response(body)) });
    servers.push(server);
    const asset = { target: "x86_64-unknown-linux-musl", format: "tar.gz" as const, sha256, bytes: body.length, filename: "uv.tar.gz", url: `http://127.0.0.1:${server.port}/uv.tar.gz` };
    const root = join(work, "routers");
    const [a, b] = await Promise.all([bootstrapUv(root, { platform: "linux", asset }), bootstrapUv(root, { platform: "linux", asset })]);
    expect(a).toBe(bootstrappedUvPath(root, "linux"));
    expect(b).toBe(a);
    expect(hits).toBe(1);
    expect(statSync(a).mode & 0o111).not.toBe(0);
    expect(await bootstrapUv(root, { platform: "linux", asset })).toBe(a);
    expect(hits).toBe(1);

    const other = join(work, "routers2");
    await expect(bootstrapUv(other, { platform: "linux", asset: { ...asset, sha256: "0".repeat(64) } })).rejects.toThrow(/checksum mismatch/);
    expect(existsSync(bootstrappedUvPath(other, "linux"))).toBe(false);
  });
});

const body = Buffer.from("fake-krt-zip");
const sha = createHash("sha256").update(body).digest("hex");
async function serve(): Promise<{ url: string; hits: () => number }> {
  let hits = 0;
  const server = Bun.serve({ port: 0, fetch: () => (hits++, new Response(body)) });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}/KiCadRoutingTools-0.23.8.zip`, hits: () => hits };
}
const krtCatalog = (url: string): RouterCatalogEntry[] => defaultRouterCatalog({ FABDESK_KRT_URL: url, FABDESK_KRT_SHA256: sha }).filter((row) => row.id === "krt");

function fakeRelease(dest: string): void {
  touch(join(dest, "plugins", "VERSION"), `${KRT_VERSION}\n`);
  touch(join(dest, "plugins", "py_router", "route.py"), "# route\n");
}
const unzip = async (_cmd: string, args: string[]) => (fakeRelease(args[args.indexOf("-d") + 1]!), 0);

async function krtRegistry(opts: { settings?: RouterRegistrySettings; env?: NodeJS.ProcessEnv; fail?: () => boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), "fabdesk-ensure-"));
  const srv = await serve();
  let setups = 0;
  const registry = createRouterRegistry({
    home,
    env: opts.env ?? {},
    catalog: krtCatalog(srv.url),
    spawn: unzip,
    ...(opts.settings ? { settings: () => opts.settings! } : {}),
    krtSetup: async (root, deps) => {
      setups++;
      deps.log?.("KRT: fake setup step");
      await new Promise((r) => setTimeout(r, 20));
      if (opts.fail?.()) throw new Error("No Python ≥ 3.12 could take the KiCadRoutingTools lock (tried: x)");
      touch(join(root, "src", "plugins", "rust_router", "grid_router.so"));
      touch(layout.krtPaths(root).python[0]!);
      return { python: layout.krtPaths(root).python[0]!, via: "fake", deps: "locked", gridRouter: "", rust: "prebuilt" };
    },
  });
  return { home, registry, hits: srv.hits, setups: () => setups };
}

describe("registry ensure", () => {
  test("a missing engine installs once for concurrent callers; every caller gets the path and progress lines", async () => {
    const { home, registry, hits, setups } = await krtRegistry();
    const a: string[] = [];
    const b: string[] = [];
    const [ra, rb] = await Promise.all([registry.ensure("krt", { onLine: (l) => a.push(l) }), registry.ensure("krt", { onLine: (l) => b.push(l) })]);
    const root = join(home, "routers", "krt");
    expect(ra).toEqual({ id: "krt", path: root, installed: true });
    expect(rb.path).toBe(root);
    expect(hits()).toBe(1);
    expect(setups()).toBe(1);
    expect(a.join("\n")).toMatch(/installing it now[\s\S]*downloading[\s\S]*verifying sha256[\s\S]*extracting[\s\S]*fake setup step[\s\S]*installed at/);
    expect(b.join("\n")).toContain("fake setup step"); // the joined caller sees the shared install's lines
    // installed: no second download
    expect(await registry.ensure("krt")).toEqual({ id: "krt", path: root });
    expect(hits()).toBe(1);
  });

  test("an override that is set but broken is reported, never installed over (even on an explicit request)", async () => {
    const { registry, hits } = await krtRegistry({ env: { FABDESK_KRT_DIR: "/nope/krt" } });
    for (const explicit of [false, true]) {
      const r = await registry.ensure("krt", { explicit });
      expect(r.path).toBeNull();
      expect(r.why).toMatch(/FABDESK_KRT_DIR is set to \/nope\/krt, which does not exist\. Fix or clear it/);
    }
    const s = await krtRegistry({ settings: { krtDir: "/tmp" } });
    expect((await s.registry.ensure("krt")).why).toMatch(/Settings krtDir is set to \/tmp, which is not a KiCadRoutingTools build/);
    expect(hits() + s.hits()).toBe(0);
  });

  test("autoInstallEngines false: automatic calls report it; an explicit install still runs", async () => {
    const { registry, hits } = await krtRegistry({ settings: { autoInstallEngines: false } });
    const r = await registry.ensure("krt");
    expect(r).toMatchObject({ path: null });
    expect(r.why).toMatch(/automatic installs are off \(Settings autoInstallEngines\)\. board_engines \{"action":"install","engine":"krt"\}/);
    expect(hits()).toBe(0);
    expect((await registry.ensure("krt", { explicit: true })).installed).toBe(true);
  });

  test("a failed automatic install is not retried automatically; an explicit install retries", async () => {
    let failing = true;
    const { registry, setups } = await krtRegistry({ fail: () => failing });
    const first = await registry.ensure("krt");
    expect(first.path).toBeNull();
    expect(first.why).toMatch(/KiCadRoutingTools did not install: No Python ≥ 3\.12/);
    const again = await registry.ensure("krt");
    expect(again.why).toMatch(/not retried automatically; board_engines/);
    expect(setups()).toBe(1);
    failing = false;
    expect((await registry.ensure("krt", { explicit: true })).installed).toBe(true);
    expect(setups()).toBe(2);
  });

  test("TraceMaker: a failed install says how to point at a reachable manifest or a binary", async () => {
    const home = await mkdtemp(join(tmpdir(), "fabdesk-ensure-tm-"));
    const catalog = defaultRouterCatalog({ FABDESK_TRACEMAKER_URL: "http://127.0.0.1:1/tm.tar.gz", FABDESK_TRACEMAKER_SHA256: sha }).filter((r) => r.id === "tracemaker");
    const registry = createRouterRegistry({ home, env: {}, catalog });
    const r = await registry.ensure("tracemaker");
    expect(r.path).toBeNull();
    expect(r.why).toMatch(/TraceMaker did not install: .*(FABDESK_TRACEMAKER_MANIFEST_URL|TRACEMAKER_BIN)/);
    expect(r.why).toContain("TRACEMAKER_BIN");
  });
});

describe("board_engines tool", () => {
  test("status lists the engines and the opt-out; install runs ensure and reports the path", async () => {
    const { home, registry } = await krtRegistry();
    const services = mockServices([]);
    services.routers = registry;
    const reg = createRegistry();
    const def = reg.get("board_engines")!;
    expect(def.toolset).toBe("board");
    const ctx = { services, progress: () => undefined, signal: new AbortController().signal } as never;
    const st = await reg.invoke("board_engines", {}, async () => ctx);
    expect(st.text).toMatch(/krt: not installed[\s\S]*kicad-cli:[\s\S]*automatic install on first use: on/);
    const inst = await reg.invoke("board_engines", { action: "install", engine: "krt" }, async () => ctx);
    expect(inst.text).toContain(`krt: ready at ${join(home, "routers", "krt")}`);
    expect(inst.json).toMatchObject({ engines: [{ id: "krt", ready: true, installed: true }] });
  });
});
