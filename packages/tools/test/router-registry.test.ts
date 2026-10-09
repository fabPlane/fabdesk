import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouterCatalogEntry } from "../src/routers/catalog";
import { downloadAndVerify, sha256File, verifyFileSha256 } from "../src/routers/checksum";
import { createRouterRegistry } from "../src/routers/registry";
import { resolveRequestedRouter } from "../src/routers/select";

const fixture = Buffer.from("fabdesk-router-fixture-v1\n");
const fixtureSha = createHash("sha256").update(fixture).digest("hex");

const servers: Array<{ stop(): void }> = [];
afterAll(() => {
  for (const server of servers) server.stop();
});

async function serveArtifact(body: Buffer, status = 200): Promise<{ url: string; stop: () => void }> {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(body, { status, headers: { "content-type": "application/octet-stream" } });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}/artifact`, stop: () => server.stop() };
}

function catalog(url: string, sha256 = fixtureSha): RouterCatalogEntry[] {
  return [
    {
      id: "fab_router",
      displayName: "fab_router",
      description: "bundled",
      strengths: ["always there"],
      license: "bundled",
      version: "bundled",
      homepage: "https://example.test",
      install: "bundled",
    },
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
        sha256,
        bytes: fixture.length,
        filename: "tracemaker",
        format: "file",
        executable: "tracemaker",
      },
    },
  ];
}

describe("checksum verification", () => {
  test("accepts a matching digest and rejects a mismatch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-sum-"));
    const path = join(dir, "artifact.bin");
    await writeFile(path, fixture);
    expect(await sha256File(path)).toBe(fixtureSha);
    await verifyFileSha256(path, fixtureSha);
    await expect(verifyFileSha256(path, "0".repeat(64))).rejects.toThrow(/checksum mismatch/);
  });

  test("downloadAndVerify writes the file only when the digest matches", async () => {
    const { url } = await serveArtifact(fixture);
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-dl-"));
    const dest = join(dir, "ok.bin");
    const result = await downloadAndVerify({ url, dest, sha256: fixtureSha, bytes: fixture.length });
    expect(result.received).toBe(fixture.length);
    expect(result.sha256).toBe(fixtureSha);
    expect(await Bun.file(dest).text()).toBe(fixture.toString());

    const bad = join(dir, "bad.bin");
    await expect(downloadAndVerify({ url, dest: bad, sha256: "a".repeat(64) })).rejects.toThrow(
      /checksum mismatch/,
    );
  });
});

describe("router registry state machine", () => {
  test("fab_router is bundled; download routers start not_installed", async () => {
    const home = await mkdtemp(join(tmpdir(), "fabdesk-reg-"));
    const { url } = await serveArtifact(fixture);
    const registry = createRouterRegistry({ home, catalog: catalog(url) });
    const list = registry.list();
    expect(list.routers.map((row) => [row.id, row.state, row.ready])).toEqual([
      ["fab_router", "bundled", true],
      ["tracemaker", "not_installed", false],
    ]);
    await expect(registry.uninstall("fab_router")).rejects.toThrow(/bundled/);
  });

  test("install verifies the checksum, then uninstall removes the artifact", async () => {
    const home = await mkdtemp(join(tmpdir(), "fabdesk-reg-"));
    const { url } = await serveArtifact(fixture);
    const registry = createRouterRegistry({ home, catalog: catalog(url) });
    const installed = await registry.install("tracemaker");
    expect(installed.state).toBe("installed");
    expect(installed.ready).toBe(true);
    expect(installed.path).toContain("tracemaker");
    expect(registry.executable("tracemaker")).toBe(installed.path);

    const gone = await registry.uninstall("tracemaker");
    expect(gone.state).toBe("not_installed");
    expect(gone.ready).toBe(false);
    expect(registry.executable("tracemaker")).toBeNull();
  });

  test("checksum mismatch and offline errors become failed, then uninstall clears them", async () => {
    const home = await mkdtemp(join(tmpdir(), "fabdesk-reg-"));
    const { url } = await serveArtifact(fixture);
    const bad = createRouterRegistry({ home, catalog: catalog(url, "b".repeat(64)) });
    const failed = await bad.install("tracemaker");
    expect(failed.state).toBe("failed");
    expect(failed.error).toMatch(/checksum mismatch/);
    expect(failed.installHint).toMatch(/TraceMaker is not installed|Last error/);

    const cleared = await bad.uninstall("tracemaker");
    expect(cleared.state).toBe("not_installed");
    expect(cleared.error).toBeUndefined();

    const offlineHome = await mkdtemp(join(tmpdir(), "fabdesk-off-"));
    const offline = createRouterRegistry({
      home: offlineHome,
      catalog: catalog("http://127.0.0.1:1/missing"),
      fetch: async () => {
        throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { cause: { code: "ENOTFOUND" } });
      },
    });
    const down = await offline.install("tracemaker");
    expect(down.state).toBe("failed");
    expect(down.error).toMatch(/offline/);
  });

  test("cancel aborts an in-flight install and leaves the router not installed", async () => {
    const home = await mkdtemp(join(tmpdir(), "fabdesk-reg-"));
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const server = Bun.serve({
      port: 0,
      async fetch() {
        await gate;
        return new Response(fixture);
      },
    });
    servers.push(server);
    const registry = createRouterRegistry({
      home,
      catalog: catalog(`http://127.0.0.1:${server.port}/artifact`),
    });
    const pending = registry.install("tracemaker");
    await Bun.sleep(20);
    expect(registry.get("tracemaker").state).toBe("installing");
    const cancelled = await registry.cancel("tracemaker");
    resume();
    const finished = await pending;
    expect(["not_installed", "failed"]).toContain(cancelled.state);
    expect(finished.state).not.toBe("installed");
    expect(registry.get("tracemaker").state).not.toBe("installed");
    server.stop();
  });

  test("TRACEMAKER_BIN marks the router installed without a download", async () => {
    const home = await mkdtemp(join(tmpdir(), "fabdesk-reg-"));
    const binDir = await mkdtemp(join(tmpdir(), "fabdesk-bin-"));
    const bin = join(binDir, "tracemaker");
    await writeFile(bin, "#!/bin/sh\nexit 0\n");
    await chmod(bin, 0o755);
    const registry = createRouterRegistry({
      home,
      catalog: catalog("http://127.0.0.1:1/unused"),
      env: { TRACEMAKER_BIN: bin },
    });
    const snap = registry.get("tracemaker");
    expect(snap.state).toBe("installed");
    expect(snap.ready).toBe(true);
    expect(snap.path).toBe(bin);
  });
});

describe("resolveRequestedRouter", () => {
  test("unpinned projects stay automatic so today's default path is unchanged", () => {
    expect(resolveRequestedRouter({})).toEqual({ automatic: true });
    expect(resolveRequestedRouter({ preferredRouter: undefined })).toEqual({ automatic: true });
  });

  test("args win over the project pin and the preferred default", () => {
    expect(
      resolveRequestedRouter({
        requested: "tracemaker",
        projectRouter: "fab_router",
        preferredRouter: "freerouting",
      }),
    ).toEqual({ selected: "tracemaker", catalogId: "tracemaker", automatic: false });
  });

  test("capacity is a fab_router alias; preferred applies only when nothing else is pinned", () => {
    expect(resolveRequestedRouter({ requested: "capacity" })).toEqual({
      selected: "capacity",
      catalogId: "fab_router",
      automatic: false,
    });
    expect(resolveRequestedRouter({ preferredRouter: "tracemaker" })).toEqual({
      selected: "tracemaker",
      catalogId: "tracemaker",
      automatic: false,
    });
  });
});
