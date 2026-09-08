import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePcbBackend } from "./pcb-supervisor";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("bundled PCB backend", () => {
  test("resolves every path relative to the manifest and forwards the platform transport", async () => {
    const resources = await mkdtemp(join(tmpdir(), "fabplane-pcb-bundle-"));
    roots.push(resources);
    const pcb = join(resources, "pcb");
    for (const dir of [join(pcb, "bin"), join(pcb, "kicad"), join(pcb, "libraries", "footprints"), join(pcb, "libraries", "symbols")]) await mkdir(dir, { recursive: true });
    await writeFile(join(pcb, "bin", "fp-pcb-bridge.exe"), "binary");
    await writeFile(join(pcb, "kicad", "kicad-cli.exe"), "binary");
    await writeFile(join(pcb, "bundle.json"), JSON.stringify({
      format: 1, target: "windows-x64", bridge: "bin/fp-pcb-bridge.exe", kicadCli: "kicad/kicad-cli.exe",
      footprints: "libraries/footprints", symbols: "libraries/symbols", environment: { KICAD_SOCKET_TRANSPORT: "ws" },
    }));

    expect(resolvePcbBackend({ packaged: true, resourcesPath: resources, env: { FABDESK_PROJECTS_DIR: "C:\\boards" } })).toMatchObject({
      command: join(pcb, "bin", "fp-pcb-bridge.exe"),
      url: "http://127.0.0.1:4020",
      env: { KICAD_SOCKET_TRANSPORT: "ws", PORT: "4020", HOST: "127.0.0.1", WORKSPACE_ROOT: "C:\\boards" },
    });
  });

  test("an unpackaged checkout without a bundle keeps the existing external-bridge workflow", async () => {
    const resources = await mkdtemp(join(tmpdir(), "fabplane-no-pcb-bundle-"));
    roots.push(resources);
    expect(resolvePcbBackend({ packaged: false, resourcesPath: resources, env: {} })).toBeNull();
  });
});
