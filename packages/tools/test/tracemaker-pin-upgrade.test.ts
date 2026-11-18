import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouterRegistry, routersRoot } from "../src/routers/registry";
import { TRACEMAKER_PINNED_MANIFEST } from "../src/routers/tracemaker-release";

test.skipIf(process.platform !== "linux" || process.arch !== "x64")("registry upgrades an old managed install from a placer-capable pin without manifest discovery", async () => {
  const home = await mkdtemp(join(tmpdir(), "fabdesk-pin-upgrade-"));
  const original = structuredClone(TRACEMAKER_PINNED_MANIFEST);
  try {
    const root = routersRoot(home);
    const pack = join(home, "pack");
    await mkdir(root, { recursive: true });
    await mkdir(pack);
    for (const filename of [join(root, "tracemaker"), join(pack, "tracemaker"), join(pack, "tracemaker-place")]) {
      await writeFile(filename, "#!/bin/sh\necho tracemaker 0.12.1\n");
      await chmod(filename, 0o755);
    }
    await writeFile(join(root, "state.json"), JSON.stringify({ routers: { tracemaker: {
      state: "installed", version: "0.12.1", path: join(root, "tracemaker"),
    } } }));
    const tar = join(home, "new.tar.gz");
    expect(Bun.spawnSync(["tar", "-czf", tar, "-C", pack, "."]).exitCode).toBe(0);
    const body = await readFile(tar);
    // Model the manifest a reviewed PR will pin; keep real installer,
    // registry upgrade and extraction, and replace only the published bytes.
    TRACEMAKER_PINNED_MANIFEST.assets = [{ platform: "linux-x86_64", filename: "new.tar.gz",
      url: "https://example.test/build/new.tar.gz", sha256: createHash("sha256").update(body).digest("hex"),
      bytes: body.length, format: "tar.gz", executable: "tracemaker", placer: "tracemaker-place" }];
    const fetches: string[] = [];
    const registry = createRouterRegistry({ home, env: {}, fetch: async (url) => {
      fetches.push(String(url));
      return new Response(body);
    } });
    expect((await registry.ensurePlacer()).path).toBe(join(root, "tracemaker", "tracemaker-place"));
    expect(fetches).toEqual(["https://example.test/build/new.tar.gz"]);
  } finally {
    Object.assign(TRACEMAKER_PINNED_MANIFEST, original);
    await rm(home, { recursive: true, force: true });
  }
});
