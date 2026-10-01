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

  test("mints a fresh bridge token per launch and hands it to the bridge", () => {
    const env = { FABDESK_FAB_CAD_SOURCE: FAB_CAD, FABDESK_PROJECTS_DIR: "/boards" };
    const a = resolveCadBackend({ resourcesPath: "/nowhere", env })!;
    const b = resolveCadBackend({ resourcesPath: "/nowhere", env })!;
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a.token, "base64url")).toHaveLength(32);
    expect(a.env.FAB_CAD_BRIDGE_TOKEN).toBe(a.token);
    expect(b.token).not.toBe(a.token);
    // A token in the environment is only for a bridge the user points at; ours gets its own.
    const own = resolveCadBackend({
      resourcesPath: "/nowhere",
      env: { ...env, FABDESK_FAB_CAD_BRIDGE_TOKEN: "user-token" },
    })!;
    expect(own.token).not.toBe("user-token");
    const external = resolveCadBackend({
      resourcesPath: "/nowhere",
      env: {
        ...env,
        FABDESK_FAB_CAD_BRIDGE_URL: "http://127.0.0.1:4555",
        FABDESK_FAB_CAD_BRIDGE_TOKEN: " user-token ",
      },
    })!;
    expect(external).toMatchObject({
      fixedUrl: true,
      token: "user-token",
      env: { FAB_CAD_BRIDGE_TOKEN: "user-token" },
    });
  });

  test("reuses a running bridge only when it takes the token", async () => {
    const projects = await temp("fabplane-cad-reuse-");
    let required: string | null = "right-token";
    const fake = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const path = new URL(req.url).pathname;
        const trusted =
          required === null || req.headers.get("authorization") === `Bearer ${required}`;
        // As fab_cad#1: an untrusted /health names the bridge but not its workspace.
        if (path === "/health")
          return Response.json(
            trusted
              ? { ok: true, name: "@fab-cad/bridge", workspaceRoot: projects }
              : { ok: true, name: "@fab-cad/bridge", uptimeSec: 1 },
          );
        if (!trusted) return Response.json({ error: "unauthorized" }, { status: 401 });
        return Response.json({ sessions: [] });
      },
    });
    try {
      const url = `http://127.0.0.1:${fake.port}`;
      const command = (token: string) =>
        resolveCadBackend({
          resourcesPath: "/nowhere",
          env: {
            FABDESK_FAB_CAD_SOURCE: FAB_CAD,
            FABDESK_PROJECTS_DIR: projects,
            FABDESK_FAB_CAD_BRIDGE_URL: url,
            FABDESK_FAB_CAD_BRIDGE_TOKEN: token,
          },
        })!;
      expect(await new CadSupervisor(command("right-token")).start()).toEqual({
        FABDESK_FAB_CAD_BRIDGE_URL: url,
        FABDESK_FAB_CAD_BRIDGE_TOKEN: "right-token",
      });
      await expect(new CadSupervisor(command("wrong-token")).start()).rejects.toThrow(
        /different bridge token.*FABDESK_FAB_CAD_BRIDGE_TOKEN/,
      );
      // A bridge from before tokens ignores the header, so it is reused as before.
      required = null;
      expect(await new CadSupervisor(command("any")).start()).toMatchObject({
        FABDESK_FAB_CAD_BRIDGE_URL: url,
      });
    } finally {
      fake.stop(true);
    }
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
      expect(env).toEqual({
        FABDESK_FAB_CAD_BRIDGE_URL: `http://127.0.0.1:${port}`,
        FABDESK_FAB_CAD_BRIDGE_TOKEN: command.token,
      });
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
