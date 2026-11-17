import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
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

  test("many waiters breaking one stale lock still admit one holder at a time", async () => {
    const dir = await mkdtemp(join(tmpdir(), "install-lock-stale-race-"));
    try {
      let active = 0;
      let max = 0;
      for (let round = 0; round < 20; round++) {
        const path = join(dir, `lock-${round}`);
        // an unreadable lock last written a minute ago: every waiter judges it stale at once
        await writeFile(path, "");
        const old = new Date(Date.now() - 60_000);
        await utimes(path, old, old);
        await Promise.all(
          Array.from({ length: 12 }, () =>
            withInstallLock(path, async () => {
              active++;
              max = Math.max(max, active);
              await Bun.sleep(5);
              active--;
            }, { pollMs: 1, waitMs: 10_000 }),
          ),
        );
      }
      expect(max).toBe(1);
      // breaking leaves nothing behind
      expect(existsSync(join(dir, "lock-0.break"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("callers in one process never overlap, even as a holder releases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "install-lock-inproc-"));
    try {
      let active = 0;
      let max = 0;
      for (let round = 0; round < 100; round++) {
        const path = join(dir, `lock-${round}`);
        await Promise.all(Array.from({ length: 12 }, () => withInstallLock(path, async () => {
          active++;
          max = Math.max(max, active);
          await Bun.sleep(1);
          active--;
        }, { pollMs: 1, waitMs: 10_000 })));
      }
      expect(max).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

  test("a lock with this process's pid but a token it does not hold is a leftover (a reused pid)", async () => {
    const path = await lockPath();
    await foreignLock(path, { pid: process.pid });
    expect(await withInstallLock(path, async () => "ran", { pollMs: 10, waitMs: 200 })).toBe("ran");
    // while this process holds it, a second caller here still waits (its own live lock is not a leftover)
    let second = false;
    await withInstallLock(path, async () => {
      const waiting = withInstallLock(path, async () => (second = true), fast);
      await sleep(60);
      expect(second).toBe(false);
      void waiting;
    }, fast);
    await sleep(60);
    expect(second).toBe(true);
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

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a state.json that cannot be read is never written over", async () => {
    const home = await mkdtemp(join(tmpdir(), "fabdesk-lockreg-"));
    const registry = createRouterRegistry({ home, catalog: catalog("http://127.0.0.1:1/x") }) as unknown as { persisted: { routers: Record<string, unknown> }; writeState(id: string): Promise<void> };
    const file = join(home, "routers", "state.json");
    await mkdir(join(home, "routers"), { recursive: true });
    // another process recorded krt after this registry started; then the file becomes unreadable for a moment
    await writeFile(file, JSON.stringify({ routers: { krt: { state: "installed", version: "0.23.8", path: "/krt" } } }));
    await chmod(file, 0o000);
    registry.persisted.routers["tracemaker"] = { state: "installed", version: "0.9.0", path: "/tm" };
    await registry.writeState("tracemaker");
    await chmod(file, 0o600);
    expect(Object.keys(JSON.parse(await readFile(file, "utf8")).routers)).toEqual(["krt"]);
    // the change was kept, not lost: the next write (for any engine) records it too
    registry.persisted.routers["atlc"] = { state: "installed", version: "4.6.1", path: "/atlc" };
    await registry.writeState("atlc");
    expect(Object.keys(JSON.parse(await readFile(file, "utf8")).routers).sort()).toEqual(["atlc", "krt", "tracemaker"]);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an older pending entry never reverts what another process recorded since", async () => {
    const home = await mkdtemp(join(tmpdir(), "fabdesk-lockreg-"));
    type Reg = { persisted: { routers: Record<string, unknown> }; writeState(id: string): Promise<void> };
    const a = createRouterRegistry({ home, catalog: catalog("http://127.0.0.1:1/x") }) as unknown as Reg;
    const b = createRouterRegistry({ home, catalog: catalog("http://127.0.0.1:1/x") }) as unknown as Reg;
    const file = join(home, "routers", "state.json");
    await mkdir(join(home, "routers"), { recursive: true });
    await writeFile(file, JSON.stringify({ routers: {} }));
    // A records an uninstall while the file is unreadable: pending
    await chmod(file, 0o000);
    a.persisted.routers["tracemaker"] = { state: "not_installed" };
    await a.writeState("tracemaker");
    await chmod(file, 0o600);
    // B installs it afterwards
    b.persisted.routers["tracemaker"] = { state: "installed", version: "2", path: "/new" };
    await b.writeState("tracemaker");
    // A's next write (another engine) must not put its older uninstall back
    a.persisted.routers["atlc"] = { state: "installed", version: "4.6.1", path: "/atlc" };
    await a.writeState("atlc");
    const disk = JSON.parse(await readFile(file, "utf8")).routers;
    expect(disk.tracemaker).toMatchObject({ state: "installed", path: "/new" });
    expect(disk.atlc).toMatchObject({ state: "installed" });
    expect(a.persisted.routers["tracemaker"]).toMatchObject({ state: "installed", path: "/new" }); // A learns the newer one
  });

  test("a stamp from a clock that ran ahead does not freeze later writes", async () => {
    const home = await mkdtemp(join(tmpdir(), "fabdesk-lockreg-"));
    type Reg = { persisted: { routers: Record<string, unknown> }; writeState(id: string): Promise<void> };
    const file = join(home, "routers", "state.json");
    await mkdir(join(home, "routers"), { recursive: true });
    // another process, its clock an hour ahead, recorded an install
    await writeFile(file, JSON.stringify({ routers: { tracemaker: { state: "installed", version: "0.8.0", path: "/tm", updatedAt: Date.now() + 3_600_000 } } }));
    const a = createRouterRegistry({ home, catalog: catalog("http://127.0.0.1:1/x") }) as unknown as Reg;
    a.persisted.routers["tracemaker"] = { state: "not_installed" };
    await a.writeState("tracemaker");
    expect(JSON.parse(await readFile(file, "utf8")).routers.tracemaker.state).toBe("not_installed");
  });

  test("cancel with nothing installing here keeps another process's install", async () => {
    const home = await mkdtemp(join(tmpdir(), "fabdesk-lockreg-"));
    const a = createRouterRegistry({ home, catalog: catalog("http://127.0.0.1:1/x") });
    const file = join(home, "routers", "state.json");
    await mkdir(join(home, "routers", "tracemaker"), { recursive: true });
    await writeFile(join(home, "routers", "tracemaker", "tracemaker"), "#!/bin/sh\n");
    await writeFile(file, JSON.stringify({ routers: { tracemaker: { state: "installed", version: "0.8.0", path: join(home, "routers", "tracemaker", "tracemaker"), updatedAt: Date.now() } } }));
    await a.cancel("tracemaker");
    expect(JSON.parse(await readFile(file, "utf8")).routers.tracemaker.state).toBe("installed");
  });

  test("two writes in one process at once both reach the file", async () => {
    const home = await mkdtemp(join(tmpdir(), "fabdesk-lockreg-"));
    const registry = createRouterRegistry({ home, catalog: catalog("http://127.0.0.1:1/x") }) as unknown as { persisted: { routers: Record<string, unknown> }; writeState(id: string): Promise<void> };
    registry.persisted.routers["krt"] = { state: "installed", version: "0.23.8", path: "/krt" };
    registry.persisted.routers["tracemaker"] = { state: "installed", version: "0.12.1", path: "/tm" };
    await Promise.all([registry.writeState("krt"), registry.writeState("tracemaker")]);
    expect(Object.keys(JSON.parse(await readFile(join(home, "routers", "state.json"), "utf8")).routers).sort()).toEqual(["krt", "tracemaker"]);
  });

  test("a corrupt state.json is kept aside and replaced, not a reason to stop recording", async () => {
    const home = await mkdtemp(join(tmpdir(), "fabdesk-lockreg-"));
    const registry = createRouterRegistry({ home, catalog: catalog("http://127.0.0.1:1/x") }) as unknown as { persisted: { routers: Record<string, unknown> }; writeState(id: string): Promise<void> };
    const file = join(home, "routers", "state.json");
    await mkdir(join(home, "routers"), { recursive: true });
    await writeFile(file, "");
    registry.persisted.routers["tracemaker"] = { state: "installed", version: "0.9.0", path: "/tm" };
    await registry.writeState("tracemaker");
    expect(Object.keys(JSON.parse(await readFile(file, "utf8")).routers)).toEqual(["tracemaker"]);
    expect((await readdir(join(home, "routers"))).some((name) => name.startsWith("state.json.corrupt-"))).toBe(true);
  });

  test("uninstall waits for another process's install of the same engine", async () => {
    const home = await mkdtemp(join(tmpdir(), "fabdesk-lockreg-"));
    const registry = createRouterRegistry({ home, catalog: catalog("http://127.0.0.1:1/x"), installLock: fast });
    let installing = true;
    const other = withInstallLock(join(home, "routers", ".lock-tracemaker"), async () => {
      await sleep(150);
      installing = false;
    }, fast);
    await sleep(20);
    await registry.uninstall("tracemaker");
    expect(installing).toBe(false);
    await other;
  });

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
    await foreignLock(lock, { pid: process.ppid }); // a live process other than this one
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
