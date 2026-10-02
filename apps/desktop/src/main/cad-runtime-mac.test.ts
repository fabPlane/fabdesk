import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAD_MAC_REQUIREMENT } from "./cad-runtime-mac";
test.skipIf(process.platform !== "darwin")(
  "strict CAD trust requirement compiles as an inline macOS expression",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "cad-requirement-test-"));
    try {
      const output = join(dir, "requirement.csreq");
      const p = Bun.spawnSync(["/usr/bin/csreq", "-r", CAD_MAC_REQUIREMENT, "-b", output]);
      expect(p.exitCode).toBe(0);
      expect((await readFile(output)).length).toBeGreaterThan(16);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
