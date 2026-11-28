import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoreServices } from "@fabdesk/tools";
import { CoreClient } from "../../../packages/client-core/src/CoreClient";
import { runPreviewTool } from "../../../packages/client-core/src/automatic-board-views";
import { ownedPreviewFixture } from "../../../packages/kicad/test/owned-schematic-fixture";
import { mockServices } from "../../../packages/tools/test/mock-services";
import { createServices } from "../src/services";
import { serve, type Daemon } from "../src/serve";

let daemon: Daemon, client: CoreClient, real: Awaited<ReturnType<typeof createServices>>;
let project: { id: string; path: string };
let mode: "healthy" | "missing" | "empty" | "coordinates" = "healthy";
const sourceFiles = ["board.kicad_sch", "child.kicad_sch", "board.kicad_pro"];
const savedEnv = { ...process.env };
const message = "KiCad did not produce a usable schematic SVG preview.";
const args = () => ({
  projectId: project.id,
  circuit: true,
  automaticPreview: true,
  maxWidth: 320,
});
async function previewFiles(
  dir = join(project.path, "renders"),
  prefix = "",
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name),
      relative = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(files, await previewFiles(path, relative + "/"));
    else
      files[relative] = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
  }
  return files;
}
const run = () =>
  runPreviewTool(
    {
      callTool: client.callTool.bind(client),
      waitJob: (id) => client.waitJob(id, { intervalMs: 5 }),
    },
    "render_schematic_svg",
    args(),
  );
async function sync() {
  return fetch(`${daemon.url}/tools/render_schematic_svg?sync=1`, {
    method: "POST",
    headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      project: project.id,
      args: { circuit: true, automaticPreview: true, maxWidth: 320 },
    }),
  });
}
beforeAll(async () => {
  const fixture = await ownedPreviewFixture();
  const cli = {
    ...fixture.cli,
    trace: async (...input: Parameters<NonNullable<typeof fixture.cli.trace>>) => {
      const command = input[0].command;
      if (command.includes("svg") && mode === "missing")
        return { exitCode: 0, stdout: "", stderr: "" };
      const result = await fixture.cli.trace!(...input);
      if (command.includes("svg")) {
        const output = command[command.indexOf("-o") + 1]!;
        for (const name of await readdir(output)) {
          const path = join(output, name);
          const svg =
            mode === "healthy"
              ? (await readFile(path, "utf8")).replace(
                  "</svg>",
                  '<rect x="10" y="10" width="20" height="10" fill="black"/></svg>',
                )
              : mode === "empty"
                ? ""
                : '<svg xmlns="http://www.w3.org/2000/svg" width="20px" height="20px" viewBox="0 0 20 20"></svg>';
          await writeFile(path, svg);
        }
      }
      return result;
    },
  };
  const home = await realpath(await mkdtemp(join(tmpdir(), "fabdesk-schematic-preview-")));
  process.env["FABDESK_PROJECTS_DIR"] = join(home, "projects");
  process.env["FABDESK_TOKEN"] = "synthetic-preview-token-0123456789abcdef";
  process.env["FABDESK_CHANNEL"] = "internal";
  daemon = await serve({
    port: 0,
    dataDir: home,
    handshakeFile: join(home, "daemon.json"),
    localAuth: true,
    parentPid: process.pid,
    quiet: true,
    watchProjects: false,
    services: async ({ projects, bus, store }) => {
      real = await createServices({
        version: "test",
        channel: "internal",
        home,
        projects,
        bus,
        routeRuns: store.routeRuns,
        settings: () => store.settings.get(),
        principal: () => null,
      });
      real.kicad.resolveCli = async () => cli;
      return mockServices([], {
        projects,
        bus: { emit: (event) => bus.emit(event) },
        routeRuns: store.routeRuns,
        channel: "internal",
        settings: () => store.settings.get(),
        kicad: real.kicad,
      }) as unknown as CoreServices;
    },
    doctor: async () => ({
      version: "test",
      channel: "internal",
      bun: Bun.version,
      platform: "test",
      kicad: { found: false },
      ngspice: { found: false },
      routers: [],
      agents: [],
      warnings: [],
    }),
  });
  client = new CoreClient({ baseUrl: daemon.url, token: daemon.token });
  project = await client.createProject("Benign schematic preview fixture");
  for (const file of sourceFiles) await cp(join(fixture.dir, file), join(project.path, file));
  const hierarchy = await real.kicad.inspectSchematicHierarchy(cli, {
    projectDir: project.path,
    rootSchematic: join(project.path, "board.kicad_sch"),
    projectFile: join(project.path, "board.kicad_pro"),
    ownedFilesOnly: true,
  });
  expect(hierarchy.issues).toEqual([]);
});
afterAll(async () => {
  await daemon?.close("preview test done");
  await real?.dispose();
  for (const key of ["FABDESK_PROJECTS_DIR", "FABDESK_TOKEN", "FABDESK_CHANNEL"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

for (const missing of ["empty", "missing"] as const)
  test(`${missing} exporter output is an expected preview failure and preserves prior artifacts`, async () => {
    mode = "healthy";
    await run();
    const previous = await previewFiles();
    const sources = await Promise.all(
      sourceFiles.map((file) => readFile(join(project.path, file))),
    );
    mode = missing;
    try {
      const response = await sync();
      expect(response.status).toBe(412);
      const body = await response.json();
      expect(body).toMatchObject({ code: "precondition" });
      expect(body.error).toContain(message);
      expect(body.error).toContain("previous preview was kept");
      await expect(run()).rejects.toThrow(message);
      expect(await previewFiles()).toEqual(previous);
      expect(
        await Promise.all(sourceFiles.map((file) => readFile(join(project.path, file)))),
      ).toEqual(sources);
    } finally {
      mode = "healthy";
    }
  });

test("unrelated framing faults remain internal failures and keep the saved preview", async () => {
  const previous = await previewFiles();
  mode = "coordinates";
  try {
    const response = await sync();
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.code).toBe("internal");
    expect(body.error).toContain("millimetre page coordinate system");
    expect(await previewFiles()).toEqual(previous);
  } finally {
    mode = "healthy";
  }
});

test("healthy document export stays unframed and healthy circuit preview still publishes PNGs", async () => {
  const document = (await runPreviewTool(client, "render_schematic_svg", {
    projectId: project.id,
    circuit: false,
    maxWidth: 320,
  })) as { json: { sheets: string[] } };
  const source = await readFile(document.json.sheets[0]!, "utf8");
  expect(source).toContain("Native test sheet");
  expect(source).not.toContain("data-fabplane-schematic-view");
  const circuit = (await run()) as { json: { sheets: string[]; images: Array<{ path: string }> } };
  expect(await readFile(circuit.json.sheets[0]!, "utf8")).toContain(
    'data-fabplane-schematic-view="circuit"',
  );
  expect((await readFile(circuit.json.images[0]!.path)).subarray(0, 8).toString("hex")).toBe(
    "89504e470d0a1a0a",
  );
});
