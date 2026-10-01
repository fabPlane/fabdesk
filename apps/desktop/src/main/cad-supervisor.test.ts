import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CadSupervisor, cadIdentityMismatch, resolveCadBackend } from "./cad-supervisor";

const FAB_CAD = resolve(import.meta.dir, "../../../../vendor/fab_cad");
const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", () => ready()));
  const address = server.address();
  await new Promise<void>((closed) => server.close(() => closed()));
  return typeof address === "object" && address ? address.port : 0;
}

describe("FabPlane CAD backend", () => {
  test("is optional: nothing to start without a bundle or a source checkout", async () => {
    const resources = await temp("fabplane-cad-none-");
    expect(resolveCadBackend({ resourcesPath: resources, env: {} })).toBeNull();
    expect(await new CadSupervisor(null).start()).toEqual({});
  });

  test("resolves a packaged bundle relative to its manifest", async () => {
    const resources = await temp("fabplane-cad-bundle-");
    const cad = join(resources, "cad");
    await mkdir(join(cad, "bin"), { recursive: true });
    await mkdir(join(cad, "web"), { recursive: true });
    await writeFile(join(cad, "bin", "fab-cad-bridge"), "binary");
    await writeFile(join(cad, "bin", "FreeCADApiServer"), "binary");
    await writeFile(
      join(cad, "bundle.json"),
      JSON.stringify({
        format: 1,
        target: "linux-x64",
        bridge: "bin/fab-cad-bridge",
        freecadApiServer: "bin/FreeCADApiServer",
        web: "web",
        environment: { FREECAD_API_SERVER_ARGS: "--module Part" },
      }),
    );
    expect(
      resolveCadBackend({ resourcesPath: resources, env: { FABDESK_PROJECTS_DIR: "/boards" } }),
    ).toMatchObject({
      command: join(cad, "bin", "fab-cad-bridge"),
      args: [],
      url: "http://127.0.0.1:4030",
      fixedUrl: false,
      env: {
        PORT: "4030",
        WORKSPACE_ROOT: "/boards",
        FREECAD_API_SERVER: `"${join(cad, "bin", "FreeCADApiServer")}"`,
        FREECAD_API_SERVER_ARGS: "--module Part",
        STATIC_DIR: join(cad, "web"),
      },
    });
  });

  test("refuses a bundle whose FreeCAD is missing", async () => {
    const resources = await temp("fabplane-cad-broken-");
    await mkdir(join(resources, "cad"), { recursive: true });
    await writeFile(join(resources, "cad", "bridge"), "binary");
    await writeFile(
      join(resources, "cad", "bundle.json"),
      JSON.stringify({
        format: 1,
        target: "linux-x64",
        bridge: "bridge",
        freecadApiServer: "FreeCADApiServer",
      }),
    );
    expect(() => resolveCadBackend({ resourcesPath: resources, env: {} })).toThrow(
      /FreeCADApiServer is missing/,
    );
  });

  test("only reuses a bridge serving the same workspace", () => {
    const command = resolveCadBackend({
      resourcesPath: "/nowhere",
      env: { FABDESK_FAB_CAD_SOURCE: FAB_CAD, FABDESK_PROJECTS_DIR: "/boards" },
    })!;
    expect(
      cadIdentityMismatch({ name: "@fab-cad/bridge", workspaceRoot: "/boards" }, command),
    ).toBeNull();
    expect(
      cadIdentityMismatch({ name: "@fab-cad/bridge", workspaceRoot: "/other" }, command),
    ).toContain("workspace");
    expect(cadIdentityMismatch({ name: "@fp-pcb/bridge" }, command)).toContain("@fp-pcb/bridge");
  });

  test("starts the bridge from a source checkout with the mock FreeCAD", async () => {
    const projects = await temp("fabplane-cad-projects-");
    const port = await freePort();
    const command = resolveCadBackend({
      resourcesPath: "/nowhere",
      env: {
        FABDESK_FAB_CAD_SOURCE: FAB_CAD,
        FABDESK_PROJECTS_DIR: projects,
        FABDESK_FAB_CAD_BRIDGE_URL: `http://127.0.0.1:${port}`,
        BUN_PATH: process.execPath,
      },
    })!;
    expect(command.env.FREECAD_API_SERVER).toContain("mock-server");
    const supervisor = new CadSupervisor(command);
    try {
      const env = await supervisor.start();
      expect(env).toEqual({ FABDESK_FAB_CAD_BRIDGE_URL: `http://127.0.0.1:${port}` });
      const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as {
        name: string;
        workspaceRoot: string;
      };
      expect(health).toMatchObject({ name: "@fab-cad/bridge", workspaceRoot: projects });
    } finally {
      await supervisor.stop();
    }
  }, 30_000);
});
