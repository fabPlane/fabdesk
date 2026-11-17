import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { RouterCatalogEntry } from "../src/routers/catalog";
import { withInstallLock } from "../src/routers/install-lock";
import { createRouterRegistry } from "../src/routers/registry";
import { bootstrappedUvPath, bootstrapUv, uvHome } from "../src/routers/uv";

const servers: Array<{ stop(): void }> = [];
afterAll(() => {
  for (const server of servers) server.stop();
});

const fast = { pollMs: 10, waitMs: 5_000 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function lockPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "fabdesk-lock-")), ".lock-test");
}

/** A lock file as another process would leave it. */
async function foreignLock(path: string, holder: { pid: number; at?: number; host?: string }): Promise<void> {
  await writeFile(path, JSON.stringify({ pid: holder.pid, host: holder.host ?? hostname(), at: holder.at ?? Date.now(), token: "other" }));
}

describe("withInstallLock", () => {
  test("two holders never overlap; the other runs after the first releases", async () => {
    const path = await lockPath();
    const events: string[] = [];
    const holder = (name: string) =>
      withInstallLock(
        path,
        async () => {
          events.push(`${name} start`);
          await sleep(60);
          events.push(`${name} end`);
          return name;
        },
        fast,
      );
    expect(await Promise.all([holder("a"), holder("b")])).toEqual(["a", "b"]);
    // Whichever wins the create, its start and end are adjacent.
    const first = events[0]!.split(" ")[0]!;
    const second = first === "a" ? "b" : "a";
    expect(events).toEqual([`${first} start`, `${first} end`, `${second} start`, `${second} end`]);
    expect(existsSync(path)).toBe(false);
  });

  test("released when the work throws", async () => {
    const path = await lockPath();
    await expect(withInstallLock(path, async () => { throw new Error("boom"); }, fast)).rejects.toThrow("boom");
    expect(existsSync(path)).toBe(false);
  });

  test("a lock whose pid is dead is taken over at once", async () => {
    const path = await lockPath();
    await foreignLock(path, { pid: 4_000_000 });
    let waited = false;
    const out = await withInstallLock(path, async () => "ran", { ...fast, isAlive: () => false, onWait: () => (waited = true) });
    expect(out).toBe("ran");
    expect(waited).toBe(false);
  });

  test("a lock older than staleMs is taken over even with a live pid", async () => {
    const path = await lockPath();
    await foreignLock(path, { pid: process.pid, at: Date.now() - 10_000 });
    expect(await withInstallLock(path, async () => "ran", { ...fast, staleMs: 1_000 })).toBe("ran");
  });

  test("an unreadable lock is taken over once it has not changed for a while, not before", async () => {
    const path = await lockPath();
    await writeFile(path, "");
    await expect(withInstallLock(path, async () => "ran", { pollMs: 10, waitMs: 50 })).rejects.toThrow(/gave up waiting/);
    const old = new Date(Date.now() - 60_000);
    await utimes(path, old, old);
    expect(await withInstallLock(path, async () => "ran", fast)).toBe("ran");
  });

  test("a live holder on another host is waited for, bounded, and the wait is abortable", async () => {
    const path = await lockPath();
    await foreignLock(path, { pid: 1, host: "elsewhere" });
    await expect(withInstallLock(path, async () => "ran", { pollMs: 10, waitMs: 50 })).rejects.toThrow(/pid 1 on elsewhere.*gave up waiting/);
    const abort = new AbortController();
    setTimeout(() => abort.abort(new Error("Installation cancelled.")), 30);
    await expect(withInstallLock(path, async () => "ran", { pollMs: 10, waitMs: 5_000, signal: abort.signal })).rejects.toThrow(/cancelled/);
    expect(existsSync(path)).toBe(true); // the other host's lock is left alone
  });
});

describe("registry install across processes", () => {
  const body = Buffer.from("fabdesk-lock-fixture\n");
  const sha256 = createHash("sha256").update(body).digest("hex");

  function catalog(url: string): RouterCatalogEntry[] {
    return [
      {
        id: "tracemaker",
        displayName: "TraceMaker",
        description: "on demand",
        strengths: ["dense pads"],
        license: "GPL-3.0-or-later",
        version: "0.8.0",
        homepage: "https://example.test/tm",
        install: "download",
        artifact: { url, sha256, bytes: body.length, filename: "tracemaker", format: "file", executable: "tracemaker" },
      },
    ];
  }

  test("two registries on one data dir (two processes) download once; the second reuses the first's install", async () => {
    let downloads = 0;
    const server = Bun.serve({
      port: 0,
      async fetch() {
        downloads += 1;
        await sleep(150);
        return new Response(body);
      },
    });
    servers.push(server);
    const home = await mkdtemp(join(tmpdir(), "fabdesk-lockreg-"));
    const url = `http://127.0.0.1:${server.port}/artifact`;
    const first = createRouterRegistry({ home, catalog: catalog(url), installLock: fast });
    const second = createRouterRegistry({ home, catalog: catalog(url), installLock: fast });
    const lines: string[] = [];
    const a = first.install("tracemaker");
    await sleep(20);
    const b = second.install("tracemaker", { onLine: (line) => lines.push(line) });
    const [one, two] = await Promise.all([a, b]);
    expect(downloads).toBe(1);
    expect(one).toMatchObject({ state: "installed", ready: true });
    expect(two).toMatchObject({ state: "installed", ready: true, path: one.path });
    expect(lines.join("\n")).toMatch(/waiting for another fabdesk process[\s\S]*installed by another fabdesk process/);
    expect(existsSync(join(home, "routers", ".lock-tracemaker"))).toBe(false);
  });

  test("a stale lock left by a dead installer does not block the install", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response(body) });
    servers.push(server);
    const home = await mkdtemp(join(tmpdir(), "fabdesk-lockreg-"));
    const registry = createRouterRegistry({
      home,
      catalog: catalog(`http://127.0.0.1:${server.port}/artifact`),
      installLock: { ...fast, isAlive: () => false },
    });
    const routers = join(home, "routers");
    await mkdir(routers, { recursive: true });
    await foreignLock(join(routers, ".lock-tracemaker"), { pid: 4_000_000 });
    expect(await registry.install("tracemaker")).toMatchObject({ state: "installed", ready: true });
  });
});

describe("bootstrapUv across processes", () => {
  test("waits for another process's bootstrap, then uses its uv without downloading", async () => {
    const root = await mkdtemp(join(tmpdir(), "fabdesk-uvlock-"));
    const lock = `${uvHome(root, "linux")}.lock`;
    await mkdir(join(root, "uv"), { recursive: true });
    await foreignLock(lock, { pid: process.pid });
    const exe = bootstrappedUvPath(root, "linux");
    setTimeout(async () => {
      await mkdir(uvHome(root, "linux"), { recursive: true });
      await writeFile(exe, "#!/bin/sh\n");
      await rm(lock);
    }, 60);
    const fetchNever = (async () => {
      throw new Error("must not download");
    }) as unknown as typeof fetch;
    expect(await bootstrapUv(root, { platform: "linux", fetch: fetchNever, lock: fast })).toBe(exe);
  });
});
