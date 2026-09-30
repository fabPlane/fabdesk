import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db";
import { parsePublicGitHubUrl } from "../src/github-import";
import { ProjectStore } from "../src/projects";
import { listKicadPcbFiles } from "../src/opensource/remix";

test("public GitHub URL accepts only owner/repository HTTPS paths", () => {
  expect(parsePublicGitHubUrl("https://github.com/TensorFleet/fabdesk")).toEqual({ url: "https://github.com/TensorFleet/fabdesk.git", owner: "TensorFleet", repo: "fabdesk" });
  expect(parsePublicGitHubUrl("https://github.com/TensorFleet/fabdesk.git").repo).toBe("fabdesk");
  for (const bad of ["http://github.com/o/r", "https://evil.example/o/r", "https://user:token@github.com/o/r", "https://github.com/o/r/issues", "https://github.com/o/r?token=x", "https://github.com/o/%2Fetc", "https://github.com/o/../r"]) {
    expect(() => parsePublicGitHubUrl(bad)).toThrow();
  }
});

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("failed and canceled clones leave no registered or partial project; collisions are preserved", async () => {
  const root = await mkdtemp(join(tmpdir(), "fabdesk-gh-test-")); roots.push(root);
  const store = Store.open(join(root, "db.sqlite"));
  const projects = new ProjectStore(store.projects, join(root, "projects"), () => {}, { watch: false });
  await projects.init();
  try {
    await expect(projects.importFromGit({ name: "bad", gitUrl: "https://github.com/o/bad.git", failOnCollision: true, clone: async (_url, dest) => { await Bun.write(join(dest, "partial.txt"), "partial"); throw new Error("offline"); } })).rejects.toThrow("offline");
    expect(projects.summaries()).toHaveLength(0);
    expect(await readdir(join(root, "projects"))).toEqual([]);
    const controller = new AbortController();
    await expect(projects.importFromGit({ name: "canceled", gitUrl: "https://github.com/o/canceled.git", signal: controller.signal, clone: async () => { controller.abort(); } })).rejects.toThrow("canceled");
    expect(projects.summaries()).toHaveLength(0);
    const made = await projects.importFromGit({ name: "good", gitUrl: "https://github.com/o/good.git", failOnCollision: true, clone: async (_url, dest) => { await Bun.write(join(dest, "README.md"), "hello"); } });
    expect(made.path).toBe(join(root, "projects", "good"));
    await expect(projects.importFromGit({ name: "good", gitUrl: "https://github.com/o/good.git", failOnCollision: true, clone: async () => { throw new Error("must not clone"); } })).rejects.toThrow("already exists");
    expect(projects.summaries()).toHaveLength(1);
  } finally { projects.close(); store.close(); }
});

test("board discovery covers zero, one, and multiple KiCad boards", async () => {
  const root = await mkdtemp(join(tmpdir(), "fabdesk-gh-boards-")); roots.push(root);
  expect(await listKicadPcbFiles(root)).toEqual([]);
  await Bun.write(join(root, "a.kicad_pcb"), "board");
  expect((await listKicadPcbFiles(root)).map((entry) => entry.path)).toEqual(["a.kicad_pcb"]);
  await Bun.write(join(root, "b.kicad_pcb"), "board");
  expect((await listKicadPcbFiles(root)).map((entry) => entry.path).sort()).toEqual(["a.kicad_pcb", "b.kicad_pcb"]);
});

test.skipIf(process.platform === "win32")("cancellation waits for git to exit before removing its destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "fabdesk-gh-cancel-")); roots.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  const git = join(bin, "git");
  // A clone may still write after receiving SIGTERM. Reproduce that window without a network.
  await Bun.write(git, `#!/bin/sh
for dest do :; done
trap 'mkdir -p "$dest"; printf late > "$dest/late"; exit 143' TERM
printf started > "$dest/started"
while :; do sleep 0.05; done
`);
  await chmod(git, 0o755);
  const previousPath = process.env["PATH"];
  process.env["PATH"] = `${bin}:${previousPath ?? ""}`;
  const store = Store.open(join(root, "db.sqlite"));
  const projects = new ProjectStore(store.projects, join(root, "projects"), () => {}, { watch: false });
  const controller = new AbortController();
  let importing: Promise<unknown> | undefined;
  try {
    await projects.init();
    importing = projects.importFromGit({ name: "canceled", gitUrl: "https://github.com/o/r.git", signal: controller.signal });
    const outcome = importing.then(() => null, (error: unknown) => error);
    const started = join(root, "projects", "canceled", "started");
    const deadline = Date.now() + 3000;
    while (!(await stat(started).catch(() => null)) && Date.now() < deadline) await Bun.sleep(10);
    expect(await stat(started).catch(() => null)).not.toBeNull();
    controller.abort();
    expect(await outcome).toMatchObject({ message: "GitHub import canceled" });
    await Bun.sleep(150);
    expect(projects.summaries()).toHaveLength(0);
    expect(await readdir(join(root, "projects"))).toEqual([]);
  } finally {
    controller.abort();
    await importing?.catch(() => {});
    if (previousPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previousPath;
    projects.close(); store.close();
  }
});
