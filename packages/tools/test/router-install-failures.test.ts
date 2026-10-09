import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry } from "../src";
import type { RouterCatalogEntry } from "../src/routers/catalog";
import { createRouterRegistry } from "../src/routers/registry";
import { contextFactory, mockServices, tempProject } from "./mock-services";

const servers: Array<{ stop(): void }> = [];
afterAll(() => {
  for (const server of servers) server.stop();
});

const sha = (body: Uint8Array | string) => createHash("sha256").update(body).digest("hex");
const tarball = Buffer.from("pretend-source-tarball\n");

const bundled: RouterCatalogEntry = {
  id: "fab_router",
  displayName: "fab_router",
  description: "bundled",
  strengths: [],
  license: "bundled",
  version: "bundled",
  homepage: "https://example.test",
  install: "bundled",
};

function sourceCatalog(url: string, extra: Partial<RouterCatalogEntry> = {}): RouterCatalogEntry[] {
  return [
    bundled,
    {
      id: "tracemaker",
      displayName: "TraceMaker",
      description: "on demand",
      strengths: ["dense pads"],
      license: "GPL-3.0-or-later",
      version: "0.8.0",
      homepage: "https://example.test/tm",
      install: "download",
      artifact: {
        url,
        sha256: sha(tarball),
        bytes: tarball.length,
        filename: "TraceMaker-0.8.0.tar.gz",
        format: "tar.gz",
        executable: "tracemaker",
      },
      ...extra,
    },
  ];
}

function serve(handler: (req: Request) => Response | Promise<Response>): { url: string; port: number } {
  const server = Bun.serve({ port: 0, fetch: handler });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, port: server.port };
}

/** Fake `tar`: unpack a source tree (no binary) into the destination like the real tarball would. */
const fakeSourceSpawn = (extraFiles: Record<string, string> = {}) => async (_cmd: string, args: string[]) => {
  const dest = args[args.indexOf("-C") + 1] as string;
  const root = join(dest, "TraceMaker-0.8.0");
  await mkdir(join(root, "src", "app"), { recursive: true });
  await writeFile(join(root, "README.md"), "source only\n");
  await writeFile(join(root, "src", "app", "main.cpp"), "int main(){}\n");
  for (const [rel, body] of Object.entries(extraFiles)) {
    await mkdir(join(root, rel, ".."), { recursive: true });
    await writeFile(join(root, rel), body);
  }
  return 0;
};

describe("source-only TraceMaker is installed but not ready", () => {
  test("a source tarball install is not ready, has no executable, and says how to fix it", async () => {
    const { url } = serve(() => new Response(tarball));
    const home = await mkdtemp(join(tmpdir(), "fabdesk-src-"));
    const registry = createRouterRegistry({
      home,
      catalog: sourceCatalog(`${url}/src.tar.gz`),
      spawn: fakeSourceSpawn(),
    });
    const snap = await registry.install("tracemaker");
    expect(snap.state).toBe("installed");
    expect(snap.ready).toBe(false);
    expect(snap.sourceOnly).toBe(true);
    expect(registry.executable("tracemaker")).toBeNull();
    // the saved path is the package directory: it must never be treated as a binary
    expect(snap.path).toMatch(/routers[\\/]tracemaker$/);
    expect(snap.installHint).toMatch(/no runnable binary/);
    expect(snap.installHint).toMatch(/TRACEMAKER_BIN/);
    expect(snap.notice).toMatch(/Only the source package was downloaded/);
    expect(snap.error).toBeUndefined();
  });

  test("a non-executable file named tracemaker is not ready", async () => {
    const { url } = serve(() => new Response(tarball));
    const home = await mkdtemp(join(tmpdir(), "fabdesk-src-"));
    const registry = createRouterRegistry({
      home,
      catalog: sourceCatalog(`${url}/src.tar.gz`),
      spawn: fakeSourceSpawn({ "scripts/tracemaker": "#!/bin/sh\n" }),
    });
    const snap = await registry.install("tracemaker");
    expect(snap.ready).toBe(false);
    expect(registry.executable("tracemaker")).toBeNull();
  });

  test("building the binary inside the package makes it ready (no reinstall needed)", async () => {
    const { url } = serve(() => new Response(tarball));
    const home = await mkdtemp(join(tmpdir(), "fabdesk-src-"));
    const registry = createRouterRegistry({
      home,
      catalog: sourceCatalog(`${url}/src.tar.gz`),
      spawn: fakeSourceSpawn(),
    });
    const before = await registry.install("tracemaker");
    expect(before.ready).toBe(false);
    const built = join(before.path as string, "TraceMaker-0.8.0", "build", "src", "app", "tracemaker");
    await mkdir(join(built, ".."), { recursive: true });
    await writeFile(built, "#!/bin/sh\nexit 0\n");
    await chmod(built, 0o755);
    const after = registry.get("tracemaker");
    expect(after.ready).toBe(true);
    expect(after.sourceOnly).toBe(false);
    expect(registry.executable("tracemaker")).toBe(built);
  });

  test("unpublished manifest: falls back to source and explains why, with no error and no ready flag", async () => {
    const { url } = serve((req) => {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/manifest.json")) return new Response("not found", { status: 404 });
      return new Response(tarball);
    });
    const home = await mkdtemp(join(tmpdir(), "fabdesk-src-"));
    const registry = createRouterRegistry({
      home,
      catalog: sourceCatalog(`${url}/src.tar.gz`, {
        binaryRelease: { repo: "TensorFleet/fabdesk", tag: "tracemaker-latest", manifestUrl: `${url}/manifest.json` },
      }),
      spawn: fakeSourceSpawn(),
    });
    const snap = await registry.install("tracemaker");
    expect(snap.state).toBe("installed");
    expect(snap.ready).toBe(false);
    expect(snap.notice).toMatch(/TraceMaker binary manifest was not reachable|not published yet/);
    expect(snap.notice).toMatch(/source package/);
  });

  test("a failing route_run says the router is not ready instead of spawning a directory", async () => {
    const project = await tempProject("tm-source-only");
    await writeFile(join(project.dir, "board.kicad_pcb"), '(kicad_pcb (net "N1"))');
    const { url } = serve(() => new Response(tarball));
    const home = await mkdtemp(join(tmpdir(), "fabdesk-src-"));
    const routers = createRouterRegistry({
      home,
      catalog: sourceCatalog(`${url}/src.tar.gz`),
      spawn: fakeSourceSpawn(),
    });
    await routers.install("tracemaker");
    const services = mockServices([project], { routers });
    const registry = createRegistry();
    const factory = contextFactory(services, project);
    await expect(
      registry.invoke("route_run", { router: "tracemaker", waitMs: 0 }, (ref) =>
        factory({ def: registry.get("route_run")!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }),
      ),
    ).rejects.toThrow(/no runnable binary yet/);
  });
});

describe("install failures are visible and leave nothing half-installed", () => {
  test("checksum mismatch: failed with the real error, no directories left, retry succeeds", async () => {
    const good = Buffer.from("#!/bin/sh\nexit 0\n");
    let serveBad = true;
    const { url } = serve(() => new Response(serveBad ? Buffer.from("#!/bin/sh\nexit 1\n") : good));
    const home = await mkdtemp(join(tmpdir(), "fabdesk-fail-"));
    const registry = createRouterRegistry({
      home,
      catalog: [
        bundled,
        {
          ...(sourceCatalog(url)[1] as RouterCatalogEntry),
          artifact: {
            url: `${url}/tracemaker`,
            sha256: sha(good),
            bytes: good.length,
            filename: "tracemaker",
            format: "file",
            executable: "tracemaker",
          },
        },
      ],
    });
    const failed = await registry.install("tracemaker");
    expect(failed.state).toBe("failed");
    expect(failed.ready).toBe(false);
    expect(failed.error).toMatch(/checksum mismatch/);
    const left = await readdir(join(home, "routers"));
    expect(left.filter((name) => name !== "state.json")).toEqual([]);
    expect(registry.executable("tracemaker")).toBeNull();

    serveBad = false;
    const retried = await registry.install("tracemaker");
    expect(retried.state).toBe("installed");
    expect(retried.ready).toBe(true);
    expect(retried.error).toBeUndefined();
  });

  test("a 404 artifact surfaces the HTTP status as the error", async () => {
    const { url } = serve(() => new Response("nope", { status: 404 }));
    const home = await mkdtemp(join(tmpdir(), "fabdesk-fail-"));
    const registry = createRouterRegistry({ home, catalog: sourceCatalog(`${url}/missing.tar.gz`) });
    const failed = await registry.install("tracemaker");
    expect(failed.state).toBe("failed");
    expect(failed.error).toMatch(/download failed \(404\)/);
    expect(failed.installHint).not.toMatch(/Last error/);
  });

  test("Bun's connection-refused message is reported as offline with the URL", async () => {
    const home = await mkdtemp(join(tmpdir(), "fabdesk-off-"));
    const registry = createRouterRegistry({
      home,
      catalog: sourceCatalog("http://127.0.0.1:1/never"),
      fetch: async () => {
        throw new Error("Unable to connect. Is the computer able to access the url?");
      },
    });
    const failed = await registry.install("tracemaker");
    expect(failed.state).toBe("failed");
    expect(failed.error).toMatch(/offline: cannot download http:\/\/127\.0\.0\.1:1\/never/);
  });

  test("progress reports determinate bytes while downloading and an extracting phase", async () => {
    const big = Buffer.alloc(256 * 1024, 7);
    const bigSha = sha(big);
    const server = Bun.serve({
      port: 0,
      fetch() {
        let sent = 0;
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (sent >= big.length) {
              controller.close();
              return;
            }
            controller.enqueue(big.subarray(sent, sent + 32 * 1024));
            sent += 32 * 1024;
            await Bun.sleep(40);
          },
        });
        return new Response(stream, { headers: { "content-length": String(big.length) } });
      },
    });
    servers.push(server);
    const home = await mkdtemp(join(tmpdir(), "fabdesk-slow-"));
    const registry = createRouterRegistry({
      home,
      catalog: sourceCatalog(`http://127.0.0.1:${server.port}/src.tar.gz`, {
        artifact: {
          url: `http://127.0.0.1:${server.port}/src.tar.gz`,
          sha256: bigSha,
          bytes: big.length,
          filename: "TraceMaker-0.8.0.tar.gz",
          format: "tar.gz",
          executable: "tracemaker",
        },
      }),
      spawn: async (cmd, args) => {
        await Bun.sleep(150);
        return fakeSourceSpawn()(cmd, args);
      },
    });
    const pending = registry.install("tracemaker");
    const seen: Array<{ phase?: string; received: number; total: number }> = [];
    while (registry.get("tracemaker").state === "installing") {
      const progress = registry.get("tracemaker").progress;
      if (progress) seen.push({ ...(progress.phase ? { phase: progress.phase } : {}), received: progress.received, total: progress.total });
      await Bun.sleep(15);
    }
    await pending;
    const downloading = seen.filter((p) => p.phase === "downloading" && p.received > 0);
    expect(downloading.length).toBeGreaterThan(1);
    expect(downloading.every((p) => p.total === big.length)).toBe(true);
    expect(Math.max(...downloading.map((p) => p.received))).toBeGreaterThan(Math.min(...downloading.map((p) => p.received)));
    expect(seen.some((p) => p.phase === "extracting")).toBe(true);
  });

  test("retrying a failed install shows installing again (not the stale failure)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const good = Buffer.from("#!/bin/sh\nexit 0\n");
    let fail = true;
    const { url } = serve(async () => {
      if (fail) return new Response("bad", { status: 500 });
      await gate;
      return new Response(good);
    });
    const home = await mkdtemp(join(tmpdir(), "fabdesk-retry-"));
    const registry = createRouterRegistry({
      home,
      catalog: [
        bundled,
        {
          ...(sourceCatalog(url)[1] as RouterCatalogEntry),
          artifact: { url: `${url}/tracemaker`, sha256: sha(good), bytes: good.length, filename: "tracemaker", format: "file", executable: "tracemaker" },
        },
      ],
    });
    expect((await registry.install("tracemaker")).state).toBe("failed");
    fail = false;
    const pending = registry.install("tracemaker");
    await Bun.sleep(30);
    expect(registry.get("tracemaker").state).toBe("installing");
    release();
    expect((await pending).state).toBe("installed");
  });
});

describe("TRACEMAKER_BIN", () => {
  test("is flagged as env-supplied, reports its real version, and a bad path is explained", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-envbin-"));
    const bin = join(dir, "tracemaker");
    await writeFile(bin, '#!/bin/sh\nif [ "$1" = "version" ]; then echo "tracemaker 1.2.3-test (stub)"; exit 0; fi\necho "A subcommand is required" >&2; exit 2\n');
    await chmod(bin, 0o755);
    const home = await mkdtemp(join(tmpdir(), "fabdesk-env-"));
    const ok = createRouterRegistry({ home, catalog: sourceCatalog("http://127.0.0.1:1/x"), env: { TRACEMAKER_BIN: bin } });
    const snap = ok.get("tracemaker");
    expect(snap.ready).toBe(true);
    expect(snap.overriddenBy).toBe("TRACEMAKER_BIN");
    expect(snap.versionInstalled).toBe("1.2.3-test");
    expect(snap.installHint).toMatch(/TRACEMAKER_BIN/);

    const plain = join(dir, "not-executable");
    await writeFile(plain, "x");
    const bad = createRouterRegistry({ home, catalog: sourceCatalog("http://127.0.0.1:1/x"), env: { TRACEMAKER_BIN: plain } });
    expect(bad.get("tracemaker").ready).toBe(false);
    expect(bad.get("tracemaker").notice).toMatch(/not a runnable executable/);
    const missing = createRouterRegistry({ home, catalog: sourceCatalog("http://127.0.0.1:1/x"), env: { TRACEMAKER_BIN: join(dir, "nope") } });
    expect(missing.get("tracemaker").notice).toMatch(/does not exist/);
    expect(existsSync(join(dir, "nope"))).toBe(false);
  });
});
