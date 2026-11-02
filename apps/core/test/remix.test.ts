import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PROJECT_FILES } from "@fabdesk/tools";
import { mockServices, tempProject } from "../../../packages/tools/test/mock-services";
import { Store } from "../src/db";
import { hydrateClonedBoard, listKicadPcbFiles, pickKicadPcb, remixCatalogProject } from "../src/opensource/remix";
import { ProjectStore } from "../src/projects";

const MINI_PCB = join(import.meta.dir, "../../../packages/kicad/test/fixtures/mini-two-layer.kicad_pcb");

describe("pickKicadPcb", () => {
  test("prefers a root-level board matching the project name", () => {
    expect(
      pickKicadPcb(
        [
          { path: "lib/footprints.kicad_pcb" },
          { path: "hardware/-backups/old.kicad_pcb" },
          { path: "pcb/nested.kicad_pcb" },
          { path: "koyomi-lvds-hat.kicad_pcb" },
          { path: "board.kicad_pcb" },
        ],
        "Koyomi LVDS HAT",
      ),
    ).toBe("koyomi-lvds-hat.kicad_pcb");
  });

  test("skips backup and library paths and returns undefined when nothing remains", () => {
    expect(pickKicadPcb([{ path: "libraries/mod.kicad_pcb" }, { path: "foo/-backups/x.kicad_pcb" }])).toBeUndefined();
  });

  test("prefers a name-matched nested board over an unrelated root PCB", () => {
    expect(
      pickKicadPcb(
        [
          { path: "unrelated.kicad_pcb" },
          { path: "hardware/koyomi-lvds-hat.kicad_pcb" },
        ],
        "Koyomi LVDS HAT",
      ),
    ).toBe("hardware/koyomi-lvds-hat.kicad_pcb");
  });
});

describe("listKicadPcbFiles", () => {
  test("finds nested boards and skips backup directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "fabdesk-pcb-walk-"));
    await mkdir(join(root, "hardware"), { recursive: true });
    await mkdir(join(root, "hardware", "-backups"), { recursive: true });
    await Bun.write(join(root, "hardware", "koyomi-lvds-hat.kicad_pcb"), "(kicad_pcb)\n");
    await Bun.write(join(root, "hardware", "-backups", "old.kicad_pcb"), "(kicad_pcb)\n");
    await Bun.write(join(root, "readme.txt"), "nope\n");
    const found = await listKicadPcbFiles(root);
    expect(found.map((f) => f.path)).toEqual(["hardware/koyomi-lvds-hat.kicad_pcb"]);
  });
});

describe("hydrateClonedBoard", () => {
  test("adopts a nested .kicad_pcb as board.kicad_pcb and renders pcb.svg when kicad-cli is there", async () => {
    const project = await tempProject("mini-board");
    await mkdir(join(project.dir, "hardware"), { recursive: true });
    await Bun.write(join(project.dir, "hardware", "mini.kicad_pcb"), await Bun.file(MINI_PCB).text());
    const hydrated = await hydrateClonedBoard({
      project,
      files: [{ path: "hardware/mini.kicad_pcb" }],
      resolveCli: async () => ({ path: "/mock/kicad-cli", version: "10.99.0" }),
      boardStats: async () => ({ copperLayers: 4 }),
      exportPcbSvg: async (_cli, o) => {
        await Bun.write(o.output, "<svg xmlns='http://www.w3.org/2000/svg'/>");
        return { paths: [o.output] };
      },
    });
    expect(hydrated?.pcbPath).toBe("hardware/mini.kicad_pcb");
    expect(await Bun.file(join(project.dir, PROJECT_FILES.boardPcb)).text()).toContain("(kicad_pcb");
    expect(await Bun.file(join(project.dir, PROJECT_FILES.renders, "pcb.svg")).text()).toContain("<svg");
    expect(project.manifest().board.layers).toBe(4);
    expect(project.manifest().importedBoard?.path).toBe("hardware/mini.kicad_pcb");
  });

  test("without kicad-cli the board is still adopted, just not rendered", async () => {
    const project = await tempProject("mini-board-nocli");
    await Bun.write(join(project.dir, "board.kicad_pcb"), await Bun.file(MINI_PCB).text());
    const hydrated = await hydrateClonedBoard({
      project,
      files: [{ path: "board.kicad_pcb" }],
      resolveCli: async () => null,
      boardStats: async () => ({}),
      exportPcbSvg: async () => ({ paths: [] }),
    });
    expect(hydrated?.pcbPath).toBe("board.kicad_pcb");
    expect(project.manifest().importedBoard?.pcbSha256).toBe(createHash("sha256").update(new Uint8Array(await Bun.file(MINI_PCB).arrayBuffer())).digest("hex"));
    expect(await Bun.file(join(project.dir, PROJECT_FILES.renders, "pcb.svg")).exists()).toBe(false);
  });
});

describe("remixCatalogProject", () => {
  const dir = { value: "" };
  let store: Store;
  let projects: ProjectStore;

  beforeAll(async () => {
    dir.value = await mkdtemp(join(tmpdir(), "fabdesk-remix-api-"));
    store = Store.open(join(dir.value, "db.sqlite"));
    projects = new ProjectStore(store.projects, join(dir.value, "projects"), () => {}, { watch: false });
    await projects.init();
  });

  afterAll(() => {
    projects.close();
    store.close();
  });

  test("lists the new project and adopts the cloned board plus pcb.svg", async () => {
    const services = mockServices([]);
    const result = await remixCatalogProject({
      source: {
        id: "tensorfleet/koyomi-lvds-hat",
        name: "Koyomi LVDS HAT",
        cloneUrl: "https://github.com/TensorFleet/koyomi-lvds-hat.git",
      },
      projects,
      services,
      clone: async (_url, dest) => {
        await mkdir(dest, { recursive: true });
        await Bun.write(join(dest, "koyomi-lvds-hat.kicad_pcb"), await Bun.file(MINI_PCB).text());
        await Bun.write(join(dest, "README.md"), "cloned\n");
      },
    });

    expect(result.sourceId).toBe("tensorfleet/koyomi-lvds-hat");
    expect(result.pcbPath).toBe("koyomi-lvds-hat.kicad_pcb");
    expect(result.project.name).toBe("Koyomi LVDS HAT");
    expect(result.project.files.some((f) => f.path === PROJECT_FILES.boardPcb)).toBe(true);
    expect(result.project.files.some((f) => f.path === `${PROJECT_FILES.renders}/pcb.svg`)).toBe(true);
    expect(result.project.files.some((f) => f.path === "koyomi-lvds-hat.kicad_pcb")).toBe(true);

    const listed = projects.summaries();
    expect(listed.some((p) => p.id === result.project.id)).toBe(true);

    expect(await Bun.file(join(result.project.path, PROJECT_FILES.boardPcb)).text()).toContain("(kicad_pcb");
    const svg = await Bun.file(join(result.project.path, PROJECT_FILES.renders, "pcb.svg")).text();
    expect(svg).toContain("<svg");
    // A new handle reads the persisted selection; rename/settings updates must not discard it.
    const imported = result.project.manifest.importedBoard;
    expect(imported?.path).toBe("koyomi-lvds-hat.kicad_pcb");
    const reopened = new ProjectStore(store.projects, join(dir.value, "projects"), () => {}, { watch: false });
    const handle = (await reopened.handle(result.project.id))!;
    expect(handle.manifest().importedBoard).toEqual(imported);
    await handle.updateManifest({ name: "Renamed imported design" });
    expect(handle.manifest().importedBoard).toEqual(imported);
    reopened.close();
  });

  test("retains the exact chosen version while leaving repository versions intact", async () => {
    const project = await tempProject("version-choice");
    const chosen = "versions/v4.1-controller-serial-bridge/board.kicad_pcb", other = "versions/v3.0/board.kicad_pcb";
    const bytes = await Bun.file(MINI_PCB).text();
    await mkdir(join(project.dir, "versions/v4.1-controller-serial-bridge"), { recursive: true });
    await mkdir(join(project.dir, "versions/v3.0"), { recursive: true });
    await Bun.write(join(project.dir, chosen), bytes);
    await Bun.write(join(project.dir, other), "older repository version");
    await hydrateClonedBoard({ project, files: [{ path: chosen }], resolveCli: async () => null, boardStats: async () => ({}), exportPcbSvg: async () => ({ paths: [] }) });
    const receipt = project.manifest().importedBoard;
    expect(receipt?.path).toBe(chosen);
    expect(receipt?.pcbSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(Number.isNaN(Date.parse(receipt!.adoptedAt))).toBe(false);
    expect(await Bun.file(join(project.dir, chosen)).text()).toBe(bytes);
    expect(await Bun.file(join(project.dir, other)).text()).toBe("older repository version");
    await Bun.write(join(project.dir, PROJECT_FILES.boardPcb), "edited working copy");
    expect(project.manifest().importedBoard).toEqual(receipt);
    expect(await Bun.file(join(project.dir, chosen)).text()).toBe(bytes);
  });
});
