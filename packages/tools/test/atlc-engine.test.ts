/**
 * atlc as a board engine: the pinned source in the catalog, install = download + sha256 + extract + build (a fake
 * tarball and an injected build; no network, no C compiler), ATLC_BIN and an atlc on PATH used as they are, and the
 * board_review short_section action. No solver run.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ATLC_SHA256, ATLC_URL, defaultRouterCatalog } from "../src/routers/catalog";
import { createRouterRegistry } from "../src/routers/registry";
import { shortSectionAction } from "../src/tools/board-review-section";

const servers: Array<{ stop(): void }> = [];
afterAll(() => {
  for (const s of servers) s.stop();
});

const touch = (path: string, body = "", mode = 0o644) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, mode);
};

describe("atlc engine", () => {
  test("catalog pins the 4.6.1 source as an engine", () => {
    const e = defaultRouterCatalog({}).find((r) => r.id === "atlc")!;
    expect(e).toMatchObject({ kind: "engine", version: "4.6.1", license: "GPL-2.0-or-later", install: "download" });
    expect(e.artifact).toMatchObject({ url: ATLC_URL, sha256: ATLC_SHA256, format: "tar.bz2", executable: "atlc-4.6.1/src/atlc" });
  });

  test("install downloads, verifies, extracts and builds; the built binary is the engine", async () => {
    const work = await mkdtemp(join(tmpdir(), "fabdesk-atlc-"));
    touch(join(work, "src", "atlc-4.6.1", "configure"), "#!/bin/sh\n", 0o755);
    const tbz = join(work, "atlc.tar.bz2");
    expect(Bun.spawnSync(["tar", "-cjf", tbz, "-C", join(work, "src"), "atlc-4.6.1"]).exitCode).toBe(0);
    const body = await readFile(tbz);
    const server = Bun.serve({ port: 0, fetch: () => new Response(body) });
    servers.push(server);
    const env = { FABDESK_ATLC_URL: `http://127.0.0.1:${server.port}/atlc.tar.bz2`, FABDESK_ATLC_SHA256: createHash("sha256").update(body).digest("hex"), PATH: "/nonexistent" };
    const built: string[] = [];
    const reg = createRouterRegistry({
      home: join(work, "home"),
      env,
      catalog: defaultRouterCatalog(env),
      atlcBuild: async (src, log) => {
        built.push(src);
        log("atlc: make");
        touch(join(src, "src", "atlc"), "#!/bin/sh\necho atlc\n", 0o755);
      },
    });
    expect(reg.get("atlc").ready).toBe(false);
    const lines: string[] = [];
    const r = await reg.ensure("atlc", { onLine: (l) => lines.push(l) });
    expect(r.path).toBe(join(work, "home", "routers", "atlc", "atlc-4.6.1", "src", "atlc"));
    expect(built).toEqual([join(work, "home", "routers", "atlc", "atlc-4.6.1")]);
    expect(lines.join("\n")).toContain("building from source");
    expect(reg.executable("atlc")).toBe(r.path);
  });

  test("a failed build is reported, not a half install", async () => {
    const work = await mkdtemp(join(tmpdir(), "fabdesk-atlc-"));
    touch(join(work, "src", "atlc-4.6.1", "configure"), "#!/bin/sh\n", 0o755);
    const tbz = join(work, "atlc.tar.bz2");
    Bun.spawnSync(["tar", "-cjf", tbz, "-C", join(work, "src"), "atlc-4.6.1"]);
    const body = await readFile(tbz);
    const server = Bun.serve({ port: 0, fetch: () => new Response(body) });
    servers.push(server);
    const env = { FABDESK_ATLC_URL: `http://127.0.0.1:${server.port}/a.tar.bz2`, FABDESK_ATLC_SHA256: createHash("sha256").update(body).digest("hex"), PATH: "/nonexistent" };
    const reg = createRouterRegistry({ home: join(work, "home"), env, catalog: defaultRouterCatalog(env), atlcBuild: async () => { throw new Error("atlc make failed (exit 2; a C compiler and make are needed)"); } });
    const r = await reg.ensure("atlc", { explicit: true });
    expect(r.path).toBeNull();
    expect(r.why).toContain("a C compiler and make are needed");
    expect(reg.get("atlc").state).toBe("failed");
  });

  test("ATLC_BIN, then an atlc on PATH, are used as they are", async () => {
    const work = await mkdtemp(join(tmpdir(), "fabdesk-atlc-"));
    const bin = join(work, "bin", "atlc");
    touch(bin, "#!/bin/sh\n", 0o755);
    const onPath = createRouterRegistry({ home: join(work, "h1"), env: { PATH: join(work, "bin") } });
    expect(onPath.get("atlc")).toMatchObject({ ready: true, path: bin, overriddenBy: "atlc on PATH" });
    expect(onPath.get("atlc").installHint).toBe(`Using the atlc on PATH at ${bin}.`);
    const other = join(work, "other", "atlc");
    touch(other, "#!/bin/sh\n", 0o755);
    const env = createRouterRegistry({ home: join(work, "h2"), env: { PATH: join(work, "bin"), ATLC_BIN: other } });
    expect(env.get("atlc")).toMatchObject({ ready: true, path: other, overriddenBy: "ATLC_BIN" });
    const broken = createRouterRegistry({ home: join(work, "h3"), env: { PATH: "", ATLC_BIN: join(work, "missing") } });
    expect((await broken.ensure("atlc")).why).toContain("does not exist");
  });
});

describe("board_review short_section", () => {
  test("writes the toolkit's record for the C6 escape cases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-short-"));
    const spec = { cases: [{ name: "FS", z0: 90, zs: 110, er: 4.1, length_mm: 6.06, rise_ns: 4 }], sources: ["x"] };
    const out = await shortSectionAction(dir, { spec, out: "s.json" });
    const rec = JSON.parse(await readFile(join(dir, "s.json"), "utf8"));
    expect(rec.rows[0].section_reflection_at_knee).toBeCloseTo(0.0065, 4);
    expect(rec.sources).toEqual(["x"]);
    expect(out.text).toContain("FS 40.9 ps, knee reflection 0.0065");
    await expect(shortSectionAction(dir, { spec: { cases: [{ z0: 90 }] } })).rejects.toThrow(/needs a number zs/);
  });
});
