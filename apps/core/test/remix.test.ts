import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importKicadPcb } from "@fabdesk/kicad";
import { PROJECT_FILES, type KicadImportSummary } from "@fabdesk/tools";
import { pcbSvg } from "@fabdesk/tscircuit";
import { mockServices, tempProject } from "../../../packages/tools/test/mock-services";
import { Store } from "../src/db";
import { hydrateClonedBoard, pickKicadPcb, remixCatalogProject } from "../src/opensource/remix";
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
});

describe("hydrateClonedBoard", () => {
  test("imports a real .kicad_pcb into circuit.json and pcb.svg", async () => {
    const project = await tempProject("mini-board");
    await Bun.write(join(project.dir, "board.kicad_pcb"), await Bun.file(MINI_PCB).text());
    await mkdir(join(project.dir, PROJECT_FILES.renders), { recursive: true });
    const hydrated = await hydrateClonedBoard({
      project,
      files: [{ path: "board.kicad_pcb" }],
      importPcb: async (o) => {
        const r = await importKicadPcb(o);
        return { circuitJson: r.circuitJson, report: r.report as unknown as KicadImportSummary };
      },
      pcbSvg,
    });
    expect(hydrated?.pcbPath).toBe("board.kicad_pcb");
    const circuit = JSON.parse(await Bun.file(join(project.dir, PROJECT_FILES.circuitJson)).text()) as unknown[];
    expect(circuit.some((el) => (el as { type?: string }).type === "pcb_board")).toBe(true);
    const svg = await Bun.file(join(project.dir, PROJECT_FILES.renders, "pcb.svg")).text();
    expect(svg).toContain("<svg");
    expect(project.manifest().board.layers).toBeGreaterThanOrEqual(2);
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

  test("lists the new project and writes circuit.json plus pcb.svg from the clone", async () => {
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
    expect(result.project.files.some((f) => f.path === PROJECT_FILES.circuitJson)).toBe(true);
    expect(result.project.files.some((f) => f.path === `${PROJECT_FILES.renders}/pcb.svg`)).toBe(true);
    expect(result.project.files.some((f) => f.path === "koyomi-lvds-hat.kicad_pcb")).toBe(true);

    const listed = projects.summaries();
    expect(listed.some((p) => p.id === result.project.id)).toBe(true);

    const circuit = JSON.parse(await Bun.file(join(result.project.path, PROJECT_FILES.circuitJson)).text()) as unknown[];
    expect(Array.isArray(circuit)).toBe(true);
    expect(circuit.length).toBeGreaterThan(0);
    const svg = await Bun.file(join(result.project.path, PROJECT_FILES.renders, "pcb.svg")).text();
    expect(svg).toContain("<svg");
  });
});
