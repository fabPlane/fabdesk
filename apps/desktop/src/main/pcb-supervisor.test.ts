import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coreEnvironment } from "./child-process-env";
import { corePcbEnvironment, PcbSupervisor, resolvePcbBackend } from "./pcb-supervisor";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("bundled PCB backend", () => {
  test("resolves every path relative to the manifest and forwards the platform transport", async () => {
    const resources = await mkdtemp(join(tmpdir(), "fabplane pcb bundle "));
    roots.push(resources);
    const pcb = join(resources, "pcb");
    for (const dir of [
      join(pcb, "bin"),
      join(pcb, "kicad", "lib", "runtime"),
      join(pcb, "kicad", "share", "kicad"),
      join(pcb, "libraries", "footprints"),
      join(pcb, "libraries", "symbols"),
    ])
      await mkdir(dir, { recursive: true });
    await writeFile(join(pcb, "bin", "fp-pcb-bridge.exe"), "binary");
    await writeFile(join(pcb, "kicad", "kicad-cli.exe"), "binary");
    await writeFile(
      join(pcb, "bundle.json"),
      JSON.stringify({
        format: 1,
        target: "windows-x64",
        bridge: "bin/fp-pcb-bridge.exe",
        kicadCli: "kicad/kicad-cli.exe",
        footprints: "libraries/footprints",
        symbols: "libraries/symbols",
        environment: { KICAD_SOCKET_TRANSPORT: "ws" },
      }),
    );

    const opts = {
      packaged: true,
      resourcesPath: resources,
      env: { FABDESK_PROJECTS_DIR: "C:\\boards", BUN_OPTIONS: "--cwd=.. --" },
    };
    const resolved = resolvePcbBackend(opts)!;
    expect(resolved).toMatchObject({
      command: join(pcb, "bin", "fp-pcb-bridge.exe"),
      args: [],
      url: "http://127.0.0.1:4020",
      env: {
        KICAD_SOCKET_TRANSPORT: "ws",
        PORT: "4020",
        HOST: "127.0.0.1",
        WORKSPACE_ROOT: "C:\\boards",
      },
    });
    const expectedOptions = (dir: string) =>
      `"--preload=${join(dir, "fabdesk-hide-pcb-console.cjs").replaceAll("\\", "/")}" --cwd=.. --`;
    expect(resolved.env.BUN_OPTIONS).toBe(process.platform === "win32" ? expectedOptions(pcb) : undefined);
    expect(corePcbEnvironment(resolved).BUN_OPTIONS).toBeUndefined();
    const manifest = join(pcb, "bundle.json");
    const dev = { ...opts, packaged: false, appPath: resources, env: { ...opts.env, FABDESK_FP_PCB_BUNDLE: manifest } };
    expect(resolvePcbBackend(dev)?.env.BUN_OPTIONS).toBeUndefined();
    const discovered = { ...dev.env, FABDESK_DEV_PCB_DISCOVERED_BUNDLE: manifest.toUpperCase() };
    expect(resolvePcbBackend({ ...dev, env: discovered })?.env.BUN_OPTIONS).toBe(
      process.platform === "win32" && process.arch === "x64" ? expectedOptions(join(resources, "scripts")) : undefined,
    );
    expect(resolvePcbBackend({ ...dev, env: { ...discovered, FABDESK_FP_PCB_BRIDGE_BIN: resolved.command } })?.env.BUN_OPTIONS).toBeUndefined();
  });

  test("resolves bundled Linux loader paths instead of depending on the host", async () => {
    const resources = await mkdtemp(join(tmpdir(), "fabplane-pcb-linux-bundle-"));
    roots.push(resources);
    const pcb = join(resources, "pcb");
    for (const dir of [
      join(pcb, "bin"),
      join(pcb, "kicad", "bin"),
      join(pcb, "kicad", "lib", "runtime"),
      join(pcb, "kicad", "share", "kicad"),
      join(pcb, "libraries", "footprints"),
      join(pcb, "libraries", "symbols"),
      join(pcb, "private", "fab_router", "src"),
      join(pcb, "freerouting", "jre", "bin"),
    ])
      await mkdir(dir, { recursive: true });
    await writeFile(join(pcb, "bin", "fp-pcb-bridge"), "binary");
    await writeFile(join(pcb, "kicad", "bin", "kicad-cli"), "binary");
    await writeFile(join(pcb, "private", "fab_router", "src", "api.ts"), "source");
    await writeFile(join(pcb, "freerouting", "freerouting.jar"), "jar");
    await writeFile(join(pcb, "freerouting", "jre", "bin", "java"), "java");
    await writeFile(
      join(pcb, "bundle.json"),
      JSON.stringify({
        format: 1,
        target: "linux-x64",
        bridge: "bin/fp-pcb-bridge",
        kicadCli: "kicad/bin/kicad-cli",
        footprints: "libraries/footprints",
        symbols: "libraries/symbols",
        fabRouter: "private/fab_router/src/api.ts",
        freerouting: { jar: "freerouting/freerouting.jar", java: "freerouting/jre/bin/java" },
        libraryPaths: ["kicad/lib", "kicad/lib/runtime"],
        environment: { KICAD_SOCKET_TRANSPORT: "ipc" },
      }),
    );

    const resolved = resolvePcbBackend({
      packaged: true,
      resourcesPath: resources,
      env: { LD_LIBRARY_PATH: "/host/lib" },
    });
    expect(resolved?.env.LD_LIBRARY_PATH).toBe(
      `${join(pcb, "kicad", "lib")}:${join(pcb, "kicad", "lib", "runtime")}:/host/lib`,
    );
    expect(resolved?.env.KICAD_STOCK_DATA_HOME).toBe(join(pcb, "kicad", "share", "kicad"));
    expect(resolved?.env.KICAD10_FOOTPRINT_DIR).toBe(join(pcb, "libraries", "footprints"));
    expect(resolved?.env.KICAD10_SYMBOL_DIR).toBe(join(pcb, "libraries", "symbols"));
    expect(resolved?.env.FAB_ROUTER_MODULE).toBe(
      join(pcb, "private", "fab_router", "src", "api.ts"),
    );
    expect(resolved?.env.FREEROUTING_JAR).toBe(join(pcb, "freerouting", "freerouting.jar"));
    expect(resolved?.env.FP_PCB_JAVA).toBe(join(pcb, "freerouting", "jre", "bin", "java"));
    expect(corePcbEnvironment(resolved!)).toMatchObject({
      KICAD_CLI: join(pcb, "kicad", "bin", "kicad-cli"),
      KICAD_STOCK_DATA_HOME: join(pcb, "kicad", "share", "kicad"),
      KICAD10_FOOTPRINT_DIR: join(pcb, "libraries", "footprints"),
      KICAD10_SYMBOL_DIR: join(pcb, "libraries", "symbols"),
      FREEROUTING_JAR: join(pcb, "freerouting", "freerouting.jar"),
      LD_LIBRARY_PATH: `${join(pcb, "kicad", "lib")}:${join(pcb, "kicad", "lib", "runtime")}:/host/lib`,
    });
    // The registry reports the installed JAR, while the bridge reports whether Java can run it.
    await rm(resolved!.env.FP_PCB_JAVA!);
    expect(corePcbEnvironment(resolved!).FREEROUTING_JAR).toBe(resolved!.env.FREEROUTING_JAR);
    // A missing or invalid JAR must not shadow core's own override or managed installation.
    const jar = join(pcb, "freerouting", "freerouting.jar");
    await rm(jar);
    expect(resolvePcbBackend({ packaged: true, resourcesPath: resources, env: {} })?.env.FREEROUTING_JAR).toBe(jar);
    expect(corePcbEnvironment(resolved!)).not.toHaveProperty("FREEROUTING_JAR");
    const override = join(resources, "custom-freerouting.jar");
    expect(coreEnvironment({ FREEROUTING_JAR: override }, corePcbEnvironment(resolved!), true).FREEROUTING_JAR)
      .toBe(override);
    await mkdir(jar);
    expect(corePcbEnvironment(resolved!)).not.toHaveProperty("FREEROUTING_JAR");
  });

  test("an unpackaged checkout without a bundle keeps the existing external-bridge workflow", async () => {
    const resources = await mkdtemp(join(tmpdir(), "fabplane-no-pcb-bundle-"));
    roots.push(resources);
    expect(resolvePcbBackend({ packaged: false, resourcesPath: resources, env: {} })).toBeNull();
  });

  test("development can run bridge source against a bundled KiCad runtime", async () => {
    const resources = await mkdtemp(join(tmpdir(), "fabplane-pcb-source-"));
    roots.push(resources);
    const pcb = join(resources, "pcb");
    const source = join(resources, "fab_pcb");
    for (const dir of [
      join(pcb, "bin"),
      join(pcb, "kicad", "bin"),
      join(pcb, "kicad", "share", "kicad"),
      join(pcb, "libraries", "footprints"),
      join(pcb, "libraries", "symbols"),
      join(source, "packages", "bridge", "src"),
    ])
      await mkdir(dir, { recursive: true });
    await writeFile(join(pcb, "bin", "fp-pcb-bridge"), "binary");
    await writeFile(join(pcb, "kicad", "bin", "kicad-cli"), "binary");
    await writeFile(join(source, "packages", "bridge", "src", "main.ts"), "source");
    await writeFile(
      join(pcb, "bundle.json"),
      JSON.stringify({
        format: 1,
        target: "linux-x64",
        bridge: "bin/fp-pcb-bridge",
        kicadCli: "kicad/bin/kicad-cli",
        footprints: "libraries/footprints",
        symbols: "libraries/symbols",
      }),
    );

    expect(
      resolvePcbBackend({
        packaged: false,
        resourcesPath: resources,
        env: { FABDESK_FP_PCB_SOURCE: source, BUN_PATH: "/opt/bun" },
      }),
    ).toMatchObject({
      command: "/opt/bun",
      args: ["run", "--filter", "@fp-pcb/bridge", "start"],
      cwd: source,
    });
  });

  test("starts the bundled bridge on another port instead of reusing an incompatible bridge", async () => {
    const root = await mkdtemp(join(tmpdir(), "fabplane-pcb-collision-"));
    roots.push(root);
    const bridgeScript = join(root, "bridge.ts");
    await writeFile(
      bridgeScript,
      `const server = Bun.serve({
  port: Number(process.env.PORT),
  hostname: "127.0.0.1",
  fetch: () => Response.json({
    name: "@fp-pcb/bridge",
    runtimeId: process.env.FABDESK_RUNTIME_ID,
    ownerPid: Number(process.env.FABDESK_DESKTOP_PID),
    kicadCli: process.env.KICAD_CLI,
    workspaceRoot: process.env.WORKSPACE_ROOT,
  }),
});
process.on("SIGTERM", () => { server.stop(true); process.exit(0); });
`,
    );
    const stale = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ name: "@fp-pcb/bridge", kicadCli: "/stale/kicad-cli" }),
    });
    const supervisor = new PcbSupervisor({
      command: process.execPath,
      args: [bridgeScript],
      cwd: root,
      url: `http://127.0.0.1:${stale.port}`,
      fixedUrl: false,
      env: {
        PORT: String(stale.port),
        KICAD_CLI: "/bundled/kicad-cli",
        KICAD_STOCK_DATA_HOME: "/bundled/share/kicad",
        KICAD_FOOTPRINT_DIR: "/bundled/footprints",
        KICAD_SYMBOL_DIR: "/bundled/symbols",
        FABDESK_RUNTIME_ID: "runtime-123456789",
        FABDESK_DESKTOP_PID: String(process.pid),
        WORKSPACE_ROOT: root,
      },
    });
    try {
      const coreEnv = await supervisor.start();
      expect(coreEnv.FABDESK_FP_PCB_BRIDGE_URL).not.toBe(`http://127.0.0.1:${stale.port}`);
      const response = await fetch(`${coreEnv.FABDESK_FP_PCB_BRIDGE_URL}/health`);
      expect(await response.json()).toMatchObject({
        name: "@fp-pcb/bridge",
        kicadCli: "/bundled/kicad-cli",
      });
    } finally {
      await supervisor.stop();
      stale.stop(true);
    }
  });

  test("rejects an explicit bridge override with a clear identity mismatch", async () => {
    const stale = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        Response.json({
          name: "@fp-pcb/bridge",
          runtimeId: "another-runtime",
          ownerPid: 1,
          kicadCli: "/bundled/kicad-cli",
          workspaceRoot: "/boards",
        }),
    });
    const supervisor = new PcbSupervisor({
      command: process.execPath,
      args: [],
      cwd: "/tmp",
      url: `http://127.0.0.1:${stale.port}`,
      fixedUrl: true,
      env: {
        KICAD_CLI: "/bundled/kicad-cli",
        KICAD_STOCK_DATA_HOME: "/bundled/share/kicad",
        KICAD_FOOTPRINT_DIR: "/bundled/footprints",
        KICAD_SYMBOL_DIR: "/bundled/symbols",
        FABDESK_RUNTIME_ID: "runtime-123456789",
        FABDESK_DESKTOP_PID: String(process.pid),
        WORKSPACE_ROOT: "/boards",
      },
    });
    try {
      await expect(supervisor.start()).rejects.toThrow(
        /identity mismatch at explicit URL.*another-runtime.*runtime-123456789/,
      );
    } finally {
      await supervisor.stop();
      stale.stop(true);
    }
  });

  test("uses the stock-data path recorded by a macOS bundle", async () => {
    const resources = await mkdtemp(join(tmpdir(), "fabplane-pcb-macos-bundle-"));
    roots.push(resources);
    const pcb = join(resources, "pcb");
    const stockData = join(pcb, "kicad", "KiCad.app", "Contents", "SharedSupport");
    for (const dir of [
      join(pcb, "bin"),
      join(pcb, "kicad", "KiCad.app", "Contents", "MacOS"),
      stockData,
      join(pcb, "libraries", "footprints"),
      join(pcb, "libraries", "symbols"),
    ])
      await mkdir(dir, { recursive: true });
    await writeFile(join(pcb, "bin", "fp-pcb-bridge"), "binary");
    await writeFile(join(pcb, "kicad", "KiCad.app", "Contents", "MacOS", "kicad-cli"), "binary");
    await writeFile(
      join(pcb, "bundle.json"),
      JSON.stringify({
        format: 1,
        target: "darwin-arm64",
        bridge: "bin/fp-pcb-bridge",
        kicadCli: "kicad/KiCad.app/Contents/MacOS/kicad-cli",
        stockData: "kicad/KiCad.app/Contents/SharedSupport",
        footprints: "libraries/footprints",
        symbols: "libraries/symbols",
      }),
    );

    expect(
      resolvePcbBackend({ packaged: true, resourcesPath: resources, env: {} })?.env
        .KICAD_STOCK_DATA_HOME,
    ).toBe(stockData);
  });
});
