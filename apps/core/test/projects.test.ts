import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
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
    const projects = new ProjectStore(store.projects, root, () => {}, { watch: false });
    await projects.init();
    const p = await projects.create("Smoke Test");
    expect(await projects.delete(p.id)).toBe(true);
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
