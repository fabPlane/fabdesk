/**
 * TraceMaker's placer (tracemaker-place, which board_route's floorplan path runs) ships beside tracemaker: the registry
 * finds it in the installed archive, a source package built in place, or beside TRACEMAKER_BIN; TRACEMAKER_PLACE_BIN
 * overrides it; an install from an archive that predates the placer is replaced once from a release that carries it;
 * board_engines status says whether it is there. No network: archives and manifests are served locally.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RouterCatalogEntry } from "../src/routers/catalog";
import { createRouterRegistry, traceMakerPlacerNear, type RouterRegistrySettings } from "../src/routers/registry";
import { TRACEMAKER_PLATFORMS } from "../src/routers/tracemaker-release";
import { createRegistry } from "../src/tools";
import { mockServices } from "./mock-services";

const servers: Array<{ stop(): void }> = [];
afterAll(() => {
  for (const server of servers) server.stop();
});

const sha = (body: Uint8Array | string) => createHash("sha256").update(body).digest("hex");
const exe = (path: string, body = "#!/bin/sh\nexit 0\n") => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
};
const posix = test.skipIf(process.platform === "win32");

describe("traceMakerPlacerNear", () => {
  posix("beside the binary, in the build tree's src/place, then anywhere under the package root; runnable files only", async () => {
    const d = await mkdtemp(join(tmpdir(), "fabdesk-placer-near-"));
    exe(join(d, "flat", "tracemaker"));
    exe(join(d, "flat", "tracemaker-place"));
    expect(traceMakerPlacerNear(join(d, "flat", "tracemaker"))).toBe(join(d, "flat", "tracemaker-place"));
    exe(join(d, "pkg", "build", "src", "app", "tracemaker"));
    exe(join(d, "pkg", "build", "src", "place", "tracemaker-place"));
    expect(traceMakerPlacerNear(join(d, "pkg", "build", "src", "app", "tracemaker"))).toBe(join(d, "pkg", "build", "src", "place", "tracemaker-place"));
    exe(join(d, "odd", "bin", "tracemaker"));
    exe(join(d, "odd", "elsewhere", "deep", "tracemaker-place"));
    expect(traceMakerPlacerNear(join(d, "odd", "bin", "tracemaker"))).toBeNull();
    expect(traceMakerPlacerNear(join(d, "odd", "bin", "tracemaker"), join(d, "odd"))).toBe(join(d, "odd", "elsewhere", "deep", "tracemaker-place"));
    exe(join(d, "noexec", "tracemaker"));
    writeFileSync(join(d, "noexec", "tracemaker-place"), "not runnable");
    expect(traceMakerPlacerNear(join(d, "noexec", "tracemaker"))).toBeNull();
  });
});

/** A tar.gz like package.sh makes: tracemaker (+ tracemaker-place unless `placer` is false) at the archive root. */
async function archive(placer: boolean): Promise<Buffer> {
  const d = await mkdtemp(join(tmpdir(), "fabdesk-tm-archive-"));
  exe(join(d, "root", "tracemaker"), "#!/bin/sh\necho tracemaker 0.12.1\n");
  if (placer) exe(join(d, "root", "tracemaker-place"));
  writeFileSync(join(d, "root", "LICENSE"), "GPL-3.0-or-later\n");
  const out = join(d, "tm.tar.gz");
  expect(Bun.spawnSync(["tar", "-czf", out, "-C", join(d, "root"), "."]).exitCode).toBe(0);
  return readFile(out);
}

/** Serves a manifest (every platform → the same archive) and the archive; `set` swaps what is published. */
async function release(placer: boolean) {
  let body = await archive(placer);
  let withPlacer = placer;
  let archiveHits = 0;
  let manifestHits = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/manifest.json") {
        manifestHits++;
        return Response.json({
          name: "tracemaker",
          builtAt: "2026-11-13T00:00:00Z",
          upstream: { repository: "https://github.com/DingoOz/TraceMaker", tag: "v0.12.1", commit: "db5950f4b8710d322ecaea3599077688a158ebfb", license: "GPL-3.0-or-later", sourceUrl: "https://example.test/src.tar.gz" },
          assets: TRACEMAKER_PLATFORMS.map((platform) => ({
            platform,
            filename: `tracemaker-${platform}.tar.gz`,
            url: `http://127.0.0.1:${server.port}/tm.tar.gz`,
            sha256: sha(body),
            bytes: body.length,
            format: "tar.gz",
            executable: "tracemaker",
            ...(withPlacer ? { placer: "tracemaker-place" } : {}),
          })),
        });
      }
      archiveHits++;
      return new Response(body);
    },
  });
  servers.push(server);
  return {
    manifestUrl: `http://127.0.0.1:${server.port}/manifest.json`,
    archiveHits: () => archiveHits,
    manifestHits: () => manifestHits,
    async set(next: boolean) {
      body = await archive(next);
      withPlacer = next;
    },
  };
}

/** The TraceMaker catalog row with the binary release on (the source fallback is never fetched here). */
function catalog(manifestUrl: string): RouterCatalogEntry[] {
  return [
    {
      id: "tracemaker",
      displayName: "TraceMaker",
      description: "on demand",
      strengths: [],
      license: "GPL-3.0-or-later",
      version: "0.8.0",
      homepage: "https://example.test/tm",
      install: "download",
      artifact: { url: "http://127.0.0.1:1/src.tar.gz", sha256: "0".repeat(64), filename: "TraceMaker-0.8.0.tar.gz", format: "tar.gz", executable: "tracemaker" },
      binaryRelease: { repo: "TensorFleet/fabdesk", tag: "tracemaker-latest", manifestUrl },
    },
  ];
}

async function registryFor(manifestUrl: string, opts: { env?: NodeJS.ProcessEnv; settings?: RouterRegistrySettings } = {}) {
  const home = await mkdtemp(join(tmpdir(), "fabdesk-placer-reg-"));
  const registry = createRouterRegistry({ home, env: opts.env ?? {}, catalog: catalog(manifestUrl), ...(opts.settings ? { settings: () => opts.settings! } : {}) });
  return { home, registry };
}

describe("registry: tracemaker-place from the installed TraceMaker", () => {
  posix("a fresh install of an archive with the placer: ready beside tracemaker, no setup", async () => {
    const rel = await release(true);
    const { home, registry } = await registryFor(rel.manifestUrl);
    expect(registry.get("tracemaker").placer).toEqual({ ready: false, why: "TraceMaker is not installed (tracemaker-place ships with it)." });
    const lines: string[] = [];
    const r = await registry.ensurePlacer({ onLine: (l) => lines.push(l) });
    const dir = join(home, "routers", "tracemaker");
    expect(r).toEqual({ path: join(dir, "tracemaker-place") });
    expect(registry.executable("tracemaker")).toBe(join(dir, "tracemaker"));
    expect(registry.get("tracemaker").placer).toEqual({ ready: true, path: join(dir, "tracemaker-place") });
    expect(lines.join("\n")).toMatch(/TraceMaker is not installed: installing it now[\s\S]*installed at/);
    expect(rel.archiveHits()).toBe(1);
  });

  posix("an archive that predates the placer: reported, replaced once the release carries it (never re-downloaded for nothing)", async () => {
    const rel = await release(false);
    const { home, registry } = await registryFor(rel.manifestUrl);
    expect((await registry.ensure("tracemaker")).path).toBe(join(home, "routers", "tracemaker", "tracemaker"));
    const old = registry.get("tracemaker").placer!;
    expect(old.ready).toBe(false);
    expect(old.why).toMatch(/has no tracemaker-place beside it \(its archive predates it\)\. board_engines \{"action":"install","engine":"tracemaker"\} reinstalls it/);
    // the published release has no placer either: no download, and the automatic path does not ask again
    const none = await registry.ensurePlacer();
    expect(none.path).toBeNull();
    expect(none.why).toMatch(/the published TraceMaker release has none yet .*TRACEMAKER_PLACE_BIN/);
    expect(rel.archiveHits()).toBe(1);
    const manifests = rel.manifestHits();
    expect((await registry.ensurePlacer()).why).toMatch(/not retried automatically/);
    expect(rel.manifestHits()).toBe(manifests);
    expect(registry.get("tracemaker").placer!.why).toMatch(/published TraceMaker release has none yet/);
    // the weekly job republished with the placer: an explicit request reinstalls and finds it
    await rel.set(true);
    const lines: string[] = [];
    const up = await registry.ensurePlacer({ explicit: true, onLine: (l) => lines.push(l) });
    expect(up).toEqual({ path: join(home, "routers", "tracemaker", "tracemaker-place"), installed: true });
    expect(rel.archiveHits()).toBe(2);
    expect(lines.join("\n")).toMatch(/has no tracemaker-place \(an older archive\): reinstalling it[\s\S]*tracemaker-place installed at/);
    expect(registry.get("tracemaker")).toMatchObject({ ready: true, placer: { ready: true } });
  });

  posix("a replacing install never swaps a working binary for the source fallback", async () => {
    const rel = await release(false);
    let gone = false;
    const server = Bun.serve({ port: 0, fetch: (req) => (gone ? new Response("not found", { status: 404 }) : fetch(rel.manifestUrl.replace("/manifest.json", new URL(req.url).pathname))) });
    servers.push(server);
    const { home, registry } = await registryFor(`http://127.0.0.1:${server.port}/manifest.json`);
    const tm = join(home, "routers", "tracemaker", "tracemaker");
    expect((await registry.ensure("tracemaker")).path).toBe(tm);
    gone = true;
    const after = await registry.install("tracemaker", { replace: true });
    expect(after).toMatchObject({ state: "installed", ready: true, path: tm });
    expect(after.error).toMatch(/no TraceMaker binary release is reachable .*kept the installed copy/);
    expect(registry.executable("tracemaker")).toBe(tm);
  });

  posix("an automatic upgrade runs when the release has the placer; autoInstallEngines false reports instead", async () => {
    const rel = await release(false);
    const off: RouterRegistrySettings = { autoInstallEngines: true };
    const { registry } = await registryFor(rel.manifestUrl, { settings: off });
    await registry.ensure("tracemaker");
    await rel.set(true);
    off.autoInstallEngines = false;
    const r = await registry.ensurePlacer();
    expect(r.path).toBeNull();
    expect(r.why).toMatch(/Automatic installs are off \(Settings autoInstallEngines\)/);
    expect(rel.archiveHits()).toBe(1);
    off.autoInstallEngines = true;
    expect((await registry.ensurePlacer()).installed).toBe(true);
    expect(rel.archiveHits()).toBe(2);
  });

  posix("TRACEMAKER_PLACE_BIN overrides (status names it); a broken one is reported and nothing installs", async () => {
    const rel = await release(true);
    const d = await mkdtemp(join(tmpdir(), "fabdesk-placer-env-"));
    const mine = exe(join(d, "my-place"));
    const ok = await registryFor(rel.manifestUrl, { env: { TRACEMAKER_PLACE_BIN: mine } });
    expect(ok.registry.get("tracemaker").placer).toEqual({ ready: true, path: mine, overriddenBy: "TRACEMAKER_PLACE_BIN" });
    expect(await ok.registry.ensurePlacer()).toEqual({ path: mine });
    const bad = await registryFor(rel.manifestUrl, { env: { TRACEMAKER_PLACE_BIN: join(d, "nope") } });
    const r = await bad.registry.ensurePlacer({ explicit: true });
    expect(r.path).toBeNull();
    expect(r.why).toMatch(/TRACEMAKER_PLACE_BIN is set to .*nope, which does not exist\. Fix or clear it\./);
    expect(rel.archiveHits()).toBe(0);
  });

  posix("beside TRACEMAKER_BIN (or its build tree); missing there is reported, not installed over", async () => {
    const rel = await release(true);
    const d = await mkdtemp(join(tmpdir(), "fabdesk-placer-bin-"));
    const tm = exe(join(d, "build", "src", "app", "tracemaker"), "#!/bin/sh\necho tracemaker 0.12.1\n");
    const lone = await registryFor(rel.manifestUrl, { env: { TRACEMAKER_BIN: tm } });
    const r = await lone.registry.ensurePlacer({ explicit: true });
    expect(r.path).toBeNull();
    expect(r.why).toMatch(/tracemaker-place is not beside TRACEMAKER_BIN=.*\. Put it there or set TRACEMAKER_PLACE_BIN/);
    exe(join(d, "build", "src", "place", "tracemaker-place"));
    expect(await lone.registry.ensurePlacer()).toEqual({ path: join(d, "build", "src", "place", "tracemaker-place") });
    expect(rel.archiveHits()).toBe(0);
  });

  posix("a source package built in place: the placer target's output is found; without it the hint says to build it", async () => {
    const tarball = Buffer.from("pretend-source-tarball\n");
    const server = Bun.serve({ port: 0, fetch: () => new Response(tarball) });
    servers.push(server);
    const home = await mkdtemp(join(tmpdir(), "fabdesk-placer-src-"));
    const registry = createRouterRegistry({
      home,
      env: {},
      catalog: [
        {
          id: "tracemaker",
          displayName: "TraceMaker",
          description: "on demand",
          strengths: [],
          license: "GPL-3.0-or-later",
          version: "0.8.0",
          homepage: "https://example.test/tm",
          install: "download",
          artifact: { url: `http://127.0.0.1:${server.port}/src.tar.gz`, sha256: sha(tarball), bytes: tarball.length, filename: "TraceMaker-0.8.0.tar.gz", format: "tar.gz", executable: "tracemaker" },
        },
      ],
      spawn: async (_cmd, args) => {
        mkdirSync(join(args[args.indexOf("-C") + 1]!, "TraceMaker-0.8.0", "src", "app"), { recursive: true });
        return 0;
      },
    });
    const pkg = (await registry.install("tracemaker")).path!;
    const build = join(pkg, "TraceMaker-0.8.0", "build", "cpu-only", "src");
    exe(join(build, "app", "tracemaker"));
    const before = registry.get("tracemaker");
    expect(before.ready).toBe(true);
    expect(before.placer!.ready).toBe(false);
    expect(before.placer!.why).toMatch(/built from source .* without tracemaker-place: build that target too \(cmake --build <build dir> --target tracemaker-place\)/);
    expect((await registry.ensurePlacer({ explicit: true })).path).toBeNull(); // a source package is never replaced
    exe(join(build, "place", "tracemaker-place"));
    expect(registry.get("tracemaker").placer).toEqual({ ready: true, path: join(build, "place", "tracemaker-place") });
  });
});

describe("board_engines and the placer", () => {
  posix("status says where tracemaker-place is (or why not); install tracemaker upgrades an older archive", async () => {
    const rel = await release(false);
    const { home, registry } = await registryFor(rel.manifestUrl);
    const services = mockServices([]);
    services.routers = registry;
    const reg = createRegistry();
    const ctx = { services, progress: () => undefined, signal: new AbortController().signal } as never;
    expect((await reg.invoke("board_engines", {}, async () => ctx)).text).not.toMatch(/placer:/); // nothing installed yet
    await registry.ensure("tracemaker");
    const missing = await reg.invoke("board_engines", {}, async () => ctx);
    expect(missing.text).toMatch(/tracemaker: ready[^\n]*\n {2}placer: missing: The installed TraceMaker/);
    expect(missing.json).toMatchObject({ engines: [{ id: "tracemaker", placer: { ready: false } }] });
    await rel.set(true);
    const inst = await reg.invoke("board_engines", { action: "install", engine: "tracemaker" }, async () => ctx);
    const placer = join(home, "routers", "tracemaker", "tracemaker-place");
    expect(inst.text).toContain(`tracemaker-place: ready at ${placer}`);
    expect(inst.json).toMatchObject({ placer: { ready: true, path: placer, installed: true } });
    expect((await reg.invoke("board_engines", {}, async () => ctx)).text).toContain(`placer: tracemaker-place at ${placer}`);
  });
});
