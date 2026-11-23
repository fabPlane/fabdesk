import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db";
import { FORGOTTEN_MANIFEST, ProjectStore } from "../src/projects";

describe("ProjectStore.delete", () => {
  let dir = "";
  let store: Store;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "fabdesk-projects-"));
    store = Store.open(join(dir, "db.sqlite"));
  });
  afterAll(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("a project deleted without purge keeps its files and stays gone after a restart", async () => {
    const root = join(dir, "projects");
    const events: Array<{ topic: string; projectId?: string }> = [];
    const projects = new ProjectStore(
      store.projects,
      root,
      (e) => events.push(e as { topic: string; projectId?: string }),
      { watch: false },
    );
    await projects.init();
    const p = await projects.create("Smoke Test");
    expect(await projects.delete(p.id)).toBe(true);
    // Announced, so the other device's project list refetches.
    expect(events.at(-1)).toMatchObject({ topic: "project.changed", projectId: p.id });
    expect(await stat(join(p.path, FORGOTTEN_MANIFEST)).then(() => true)).toBe(true);
    expect(await stat(join(p.path, "fabdesk.json")).catch(() => null)).toBeNull();
    projects.close();

    const again = new ProjectStore(store.projects, root, () => {}, { watch: false });
    await again.init();
    expect((await again.list()).map((h) => h.id)).not.toContain(p.id);
    again.close();
  });

  test("purge removes the directory", async () => {
    const projects = new ProjectStore(store.projects, join(dir, "projects2"), () => {}, {
      watch: false,
    });
    await projects.init();
    const p = await projects.create("Gone");
    await projects.delete(p.id, { purge: true });
    expect(await stat(p.path).catch(() => null)).toBeNull();
    projects.close();
  });
});

describe("ProjectStore absolute-path resolution", () => {
  test("absolute copies are ephemeral and cannot repoint a canonical project", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-ephemeral-projects-"));
    const store = Store.open(join(dir, "db.sqlite"));
    const projectsRoot = join(dir, "projects");
    const projects = new ProjectStore(store.projects, projectsRoot, () => {}, { debounceMs: 5 });
    try {
      await projects.init();
      const canonical = await projects.create("Canonical Project");
      for (const path of ["board.kicad_pro", "board.kicad_sch", "board.kicad_pcb"])
        await writeFile(join(canonical.path, path), `canonical-${path}`);
      await Bun.sleep(20);
      const canonicalHandle = await projects.handle(canonical.id);
      expect(canonicalHandle?.dir).toBe(canonical.path);

      const createCopy = async (name: string, id: string) => {
        const copy = join(dir, "external", name);
        await mkdir(copy, { recursive: true });
        const now = new Date().toISOString();
        await writeFile(
          join(copy, "fabdesk.json"),
          JSON.stringify({
            schema: 1,
            id,
            name,
            createdAt: now,
            updatedAt: now,
            board: { layers: 2 },
            router: "fab_router",
          }),
        );
        for (const path of ["board.kicad_pro", "board.kicad_sch", "board.kicad_pcb"])
          await writeFile(join(copy, path), `${name}-${path}`);
        // Project handles canonicalize macOS /var and /private/var aliases.
        return await realpath(copy);
      };

      const rowsBefore = store.projects.list();
      const watchersBefore = (projects as any).watchers.size;
      const handlesBefore = (projects as any).handles.size;
      const unique = await createCopy("Unique Copy", "prj_ephemeral_unique");
      const uniqueHandle = await projects.resolve(unique);
      expect(uniqueHandle).toMatchObject({ id: "prj_ephemeral_unique", dir: unique });
      expect(store.projects.list()).toEqual(rowsBefore);
      expect((projects as any).watchers.size).toBe(watchersBefore);
      expect((projects as any).handles.size).toBe(handlesBefore);
      expect(await projects.resolve("prj_ephemeral_unique")).toBeNull();

      const duplicate = await createCopy("Duplicate Copy", canonical.id);
      const duplicateHandle = await projects.resolve(duplicate);
      expect(duplicateHandle).toMatchObject({
        id: canonical.id,
        name: "Duplicate Copy",
        dir: duplicate,
      });
      expect(store.projects.list()).toEqual(rowsBefore);
      expect((projects as any).watchers.size).toBe(watchersBefore);
      expect((projects as any).handles.size).toBe(handlesBefore);
      expect(await projects.resolve(canonical.id)).toBe(canonicalHandle);
      expect((await projects.resolve("Canonical Project"))?.dir).toBe(canonical.path);

      const invalid = join(dir, "external", "invalid");
      await mkdir(invalid, { recursive: true });
      await writeFile(join(invalid, "fabdesk.json"), "not-json");
      expect(await projects.resolve(invalid)).toBeNull();
      const missingNative = await createCopy("Missing Native", "prj_missing_native");
      await unlink(join(missingNative, "board.kicad_pcb"));
      expect(await projects.resolve(missingNative)).toBeNull();
      const escaped = await createCopy("Escaped Native", "prj_escaped_native");
      const outside = join(dir, "outside.kicad_sch");
      await writeFile(outside, "outside");
      await unlink(join(escaped, "board.kicad_sch"));
      // Junctions exercise the same realpath jail on Windows without requiring
      // Developer Mode or administrator privileges for file symlinks.
      await symlink(process.platform === "win32" ? dir : outside,
        join(escaped, "board.kicad_sch"), process.platform === "win32" ? "junction" : "file");
      expect(await projects.resolve(escaped)).toBeNull();
      expect(await projects.resolve(join(dir, "does-not-exist"))).toBeNull();
      expect(store.projects.list()).toEqual(rowsBefore);
      expect((projects as any).watchers.size).toBe(watchersBefore);

      projects.close();
      const restarted = new ProjectStore(store.projects, projectsRoot, () => {}, { watch: false });
      await restarted.init();
      expect((await restarted.resolve(canonical.id))?.dir).toBe(canonical.path);
      expect(await restarted.resolve("prj_ephemeral_unique")).toBeNull();
      restarted.close();
    } finally {
      projects.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ProjectStore custom locations", () => {
  test("creates outside the default root, avoids existing folders, and survives restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-location-"));
    const store = Store.open(join(dir, "db.sqlite"));
    const root = join(dir, "default");
    const parent = join(dir, "chosen");
    const projects = new ProjectStore(store.projects, root, () => {}, { watch: false });
    const restarted = new ProjectStore(store.projects, root, () => {}, { watch: false });
    try {
      await mkdir(join(parent, "my-board"), { recursive: true });
      await writeFile(join(parent, "my-board", "keep.txt"), "existing data");
      const project = await projects.create("My Board", parent);
      expect(project.path).toBe(join(await realpath(parent), "my-board-2"));
      expect(await Bun.file(join(parent, "my-board", "keep.txt")).text()).toBe("existing data");
      expect(await Bun.file(join(project.path, "fabdesk.json")).exists()).toBe(true);
      await restarted.init();
      expect((await restarted.detail(project.id))?.path).toBe(project.path);
      const ordinary = await projects.create("Default Board");
      expect(ordinary.path).toBe(join(root, "default-board"));
      expect(ordinary.manifest.board.material).toBeUndefined();
      const flex = await projects.create("Probe Tail", undefined, { material: "flex", construction: "2l" });
      expect(flex.manifest.board.material).toBe("flex");
      expect(flex.manifest.board.construction).toBe("2l");
      expect(flex.manifest.board.layers).toBe(2);
      const concurrent = await Promise.all([projects.create("Parallel", parent), projects.create("Parallel", parent)]);
      expect(new Set(concurrent.map((p) => p.path)).size).toBe(2);
      const otherParent = join(dir, "other");
      await mkdir(otherParent);
      const acrossParents = await Promise.all([projects.create("Across", parent), projects.create("Across", otherParent)]);
      expect(new Set(acrossParents.map((p) => p.id)).size).toBe(2);
      await expect(projects.create("Relative", "relative/path")).rejects.toThrow("absolute");
      await expect(projects.create("File", join(parent, "my-board", "keep.txt"))).rejects.toThrow("folder");
    } finally {
      projects.close();
      restarted.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
