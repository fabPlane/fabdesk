import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db";
import { allowedCloneUrl, fetchOpenCatalog, findCatalogProject } from "../src/opensource/catalog";
import { assessOrderReadiness, startOrderSession } from "../src/opensource/order";
import { OPEN_CATALOG_SEED } from "../src/opensource/seed";
import { ProjectStore } from "../src/projects";

describe("open catalog", () => {
  test("seed has twenty unique PCB projects", () => {
    expect(OPEN_CATALOG_SEED).toHaveLength(20);
    expect(new Set(OPEN_CATALOG_SEED.map((p) => p.id)).size).toBe(20);
  });

  test("fetchOpenCatalog falls back to the seed when the API is down", async () => {
    const index = await fetchOpenCatalog("http://127.0.0.1:9", "lvds", async () => {
      throw new Error("offline");
    });
    expect(index.source).toBe("seed");
    expect(index.projects.map((p) => p.id)).toEqual(["tensorfleet/koyomi-lvds-hat"]);
  });

  test("fetchOpenCatalog prefers a live API payload", async () => {
    const index = await fetchOpenCatalog("https://api.fabplane.com", undefined, async () =>
      Response.json({
        generatedAt: "2026-09-03T00:00:00.000Z",
        source: "r2-list",
        projects: [OPEN_CATALOG_SEED[0]],
      }),
    );
    expect(index.source).toBe("r2-list");
    expect(index.projects).toHaveLength(1);
    expect(findCatalogProject(index, "tensorfleet/koyomi-lvds-hat")?.name).toBe("Koyomi LVDS HAT");
  });

  test("allowedCloneUrl only accepts https GitHub git URLs", () => {
    expect(allowedCloneUrl("https://github.com/TensorFleet/koyomi-lvds-hat.git")).toBe(true);
    expect(allowedCloneUrl("https://evil.example/x.git")).toBe(false);
    expect(allowedCloneUrl("git@github.com:TensorFleet/koyomi-lvds-hat.git")).toBe(false);
  });
});

describe("order readiness", () => {
  test("is ready when gerbers, a zip, KiCad, or a routed board exist", () => {
    expect(assessOrderReadiness([]).ready).toBe(false);
    expect(assessOrderReadiness([{ path: "circuit.tsx" }]).ready).toBe(false);
    expect(assessOrderReadiness([{ path: "board.kicad_pcb" }]).ready).toBe(true);
    expect(assessOrderReadiness([{ path: "exports/gerbers/F_Cu.gbr" }]).ready).toBe(true);
    expect(assessOrderReadiness([{ path: "exports/fabrication.zip" }]).ready).toBe(true);
    expect(assessOrderReadiness([{ path: "circuit.routed.json" }]).ready).toBe(true);
  });

  test("JLCPCB and PCBWay are enabled; laser and CNC are not", () => {
    expect(startOrderSession("jlcpcb").enabled).toBe(true);
    expect(startOrderSession("pcbway").orderUrl).toContain("pcbway.com");
    expect(startOrderSession("laser").enabled).toBe(false);
    expect(startOrderSession("cnc").enabled).toBe(false);
  });
});

describe("remix import", () => {
  const dir = { value: "" };
  let store: Store;
  let projects: ProjectStore;

  beforeAll(async () => {
    dir.value = await mkdtemp(join(tmpdir(), "fabdesk-remix-"));
    store = Store.open(join(dir.value, "db.sqlite"));
    projects = new ProjectStore(store.projects, join(dir.value, "projects"), () => {}, { watch: false });
    await projects.init();
  });

  afterAll(() => {
    projects.close();
    store.close();
  });

  test("importFromGit registers a cloned tree as a project", async () => {
    const detail = await projects.importFromGit({
      name: "Koyomi remix",
      gitUrl: "https://github.com/TensorFleet/koyomi-lvds-hat.git",
      clone: async (_url, dest) => {
        await Bun.write(join(dest, "README.md"), "cloned\n");
        await Bun.write(join(dest, "board.kicad_pcb"), "(kicad_pcb)\n");
      },
    });
    expect(detail.name).toBe("Koyomi remix");
    expect(detail.files.some((f) => f.path === "board.kicad_pcb")).toBe(true);
    expect(detail.files.some((f) => f.path === "fabdesk.json")).toBe(true);
    expect(assessOrderReadiness(detail.files).ready).toBe(true);
  });
});
