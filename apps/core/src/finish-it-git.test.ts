import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitMilestone, ensureProjectGit } from "./finish-it-git";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "fabdesk-finish-git-"));
}

describe("commitMilestone", () => {
  test("inits a repo and commits when files change", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "circuit.netlist.json"), "{\"ok\":true}\n");
    const sha = await commitMilestone(dir, "finish-it: schematic");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const log = Bun.spawn(["git", "-C", dir, "log", "-1", "--pretty=%s"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await new Response(log.stdout).text()).toContain("finish-it: schematic");
  });

  test("returns null when there is nothing new to commit", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "board.kicad_pcb"), "(kicad_pcb)\n");
    const first = await commitMilestone(dir, "finish-it: build");
    expect(first).toBeString();
    const second = await commitMilestone(dir, "finish-it: build");
    expect(second).toBeNull();
  });

  test("ensureProjectGit is idempotent", async () => {
    const dir = await tempDir();
    await ensureProjectGit(dir);
    await ensureProjectGit(dir);
    const probe = Bun.spawn(["git", "-C", dir, "rev-parse", "--is-inside-work-tree"], {
      stdout: "pipe",
    });
    expect((await new Response(probe.stdout).text()).trim()).toBe("true");
  });
});
