import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitMilestone, ensureProjectGit } from "./finish-it-git";

async function tempDir(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "fabdesk-finish-git-")));
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

  test("inits a nested repo when the project sits inside another work tree", async () => {
    const parent = await tempDir();
    const init = Bun.spawn(["git", "init"], { cwd: parent, stdout: "pipe", stderr: "pipe" });
    expect(await init.exited).toBe(0);
    await writeFile(join(parent, "unrelated.txt"), "leave me alone\n");
    const project = join(parent, "boards", "usb");
    await mkdir(join(parent, "boards", "usb"), { recursive: true });
    await writeFile(join(project, "board.kicad_pcb"), "(kicad_pcb)\n");
    const sha = await commitMilestone(project, "finish-it: build");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const parentLog = Bun.spawn(["git", "-C", parent, "log", "--oneline"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await parentLog.exited).not.toBe(0);
    const nested = Bun.spawn(["git", "-C", project, "rev-parse", "--show-toplevel"], {
      stdout: "pipe",
    });
    expect((await new Response(nested.stdout).text()).trim()).toBe(project);
    const ignore = await Bun.file(join(project, ".gitignore")).text();
    expect(ignore).toContain(".fabdesk/runs/");
  });

  test("writes .gitignore into a pre-existing project repo", async () => {
    const dir = await tempDir();
    const init = Bun.spawn(["git", "init"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    expect(await init.exited).toBe(0);
    await ensureProjectGit(dir);
    expect(await Bun.file(join(dir, ".gitignore")).text()).toContain(".fabdesk/cache/");
  });
});
