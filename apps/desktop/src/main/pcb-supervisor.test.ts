import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { corePcbEnvironment, resolvePcbBackend } from "./pcb-supervisor";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("bundled PCB backend", () => {
  test("resolves every path relative to the manifest and forwards the platform transport", async () => {
    const resources = await mkdtemp(join(tmpdir(), "fabplane-pcb-bundle-"));
    roots.push(resources);
    const pcb = join(resources, "pcb");
    for (const dir of [
      join(pcb, "bin"),
      join(pcb, "kicad", "lib", "runtime"),
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

    expect(
      resolvePcbBackend({
        packaged: true,
        resourcesPath: resources,
        env: { FABDESK_PROJECTS_DIR: "C:\\boards" },
      }),
    ).toMatchObject({
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
  });

  test("resolves bundled Linux loader paths instead of depending on the host", async () => {
    const resources = await mkdtemp(join(tmpdir(), "fabplane-pcb-linux-bundle-"));
    roots.push(resources);
    const pcb = join(resources, "pcb");
    for (const dir of [
      join(pcb, "bin"),
      join(pcb, "kicad", "bin"),
      join(pcb, "kicad", "lib", "runtime"),
      join(pcb, "libraries", "footprints"),
      join(pcb, "libraries", "symbols"),
      join(pcb, "private", "js_autorouter", "src"),
      join(pcb, "private", "freerouting", "jdk", "bin"),
    ])
      await mkdir(dir, { recursive: true });
    await writeFile(join(pcb, "bin", "fp-pcb-bridge"), "binary");
    await writeFile(join(pcb, "kicad", "bin", "kicad-cli"), "binary");
    await writeFile(join(pcb, "private", "js_autorouter", "src", "index.ts"), "source");
    await writeFile(join(pcb, "private", "freerouting", "freerouting.jar"), "jar");
    await writeFile(join(pcb, "private", "freerouting", "jdk", "bin", "java"), "java");
    await writeFile(
      join(pcb, "bundle.json"),
      JSON.stringify({
        format: 1,
        target: "linux-x64",
        bridge: "bin/fp-pcb-bridge",
        kicadCli: "kicad/bin/kicad-cli",
        footprints: "libraries/footprints",
        symbols: "libraries/symbols",
        jsAutorouter: "private/js_autorouter/src/index.ts",
        freeroutingJar: "private/freerouting/freerouting.jar",
        freeroutingJava: "private/freerouting/jdk/bin/java",
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
    expect(resolved?.env.JS_AUTOROUTER_MODULE).toBe(
      join(pcb, "private", "js_autorouter", "src", "index.ts"),
    );
    expect(resolved?.env.FREEROUTING_JAR).toBe(
      join(pcb, "private", "freerouting", "freerouting.jar"),
    );
    expect(resolved?.env.FP_PCB_JAVA).toBe(
      join(pcb, "private", "freerouting", "jdk", "bin", "java"),
    );
    expect(corePcbEnvironment(resolved!)).toMatchObject({
      KICAD_CLI: join(pcb, "kicad", "bin", "kicad-cli"),
      KICAD_STOCK_DATA_HOME: join(pcb, "kicad", "share", "kicad"),
      LD_LIBRARY_PATH: `${join(pcb, "kicad", "lib")}:${join(pcb, "kicad", "lib", "runtime")}:/host/lib`,
    });
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
});
