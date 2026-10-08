#!/usr/bin/env bun
/** Exercise the packaged resolver and a real engine against disposable CAD data. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CadSupervisor, resolveCadBackend } from "../apps/desktop/src/main/cad-supervisor";
import { FabCadBridgeClient } from "../apps/core/src/fab-cad-bridge";
import { createFabCad } from "../apps/core/src/fab-cad";

export async function smokeCadBundle(manifest: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "fabdesk-native-smoke-"));
  const listener = createServer();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  const address = listener.address();
  assert(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  await new Promise<void>((done) => listener.close(() => done()));
  const command = resolveCadBackend({
    packaged: true,
    resourcesPath: "/unused",
    env: {
      FABDESK_FAB_CAD_BUNDLE: resolve(manifest),
      FABDESK_PROJECTS_DIR: root,
      FABDESK_FAB_CAD_BRIDGE_URL: url,
    },
  });
  assert(command);
  command.env.HOME = root;
  command.env.FREECAD_USER_HOME = root;
  const supervisor = new CadSupervisor(command);
  let cad: ReturnType<typeof createFabCad> | undefined;
  try {
    const env = await supervisor.start();
    assert.equal((await fetch(`${url}/health`)).status, 401);
    assert.equal(
      (await fetch(`${url}/health`, { headers: { origin: "https://untrusted.example" } })).status,
      403,
    );
    const client = new FabCadBridgeClient({ url, token: env.FABDESK_FAB_CAD_BRIDGE_TOKEN });
    const health = await client.health();
    assert(
      !health.serverCommand?.some((p) => /mock-server/.test(p)),
      "mock engine cannot satisfy native smoke",
    );
    const project = join(root, "real-engine-model");
    await mkdir(project);
    cad = createFabCad({ bridge: () => client, clientName: "fabdesk/native-package-smoke" });
    await cad.model(project);
    const info = await cad.python(
      project,
      "import FreeCAD, Part, Sketcher, PartDesign, sys\nassert sys.dont_write_bytecode\nassert sys.flags.no_user_site\nprint(FreeCAD.Version())",
      "exec",
    );
    assert(!info.exception, JSON.stringify(info));
    assert(info.stdout.length > 0, "real FreeCAD version must be reported");
    await cad.addObject(project, {
      type: "Part::Box",
      name: "Enclosure",
      properties: { Length: 40, Width: 30, Height: 2 },
    });
    assert.deepEqual((await cad.recompute(project)).errors, []);
    await cad.save(project);
    const modelPath = join(project, "model.FCStd");
    const bytes = await readFile(modelPath);
    assert.equal(
      bytes.subarray(0, 2).toString(),
      "PK",
      "FCStd must be a real ZIP document, not mock JSON",
    );
    const step = await cad.export(project, { format: "step" });
    assert(
      new TextDecoder().decode(step.data).includes("ISO-10303-21"),
      "STEP must contain real OCCT geometry",
    );
    assert(step.data.length > 500);
    await writeFile(join(project, "model.step"), step.data);
    const sessions = await client.sessions();
    await cad.dispose();
    cad = undefined;
    for (const session of sessions) await client.deleteSession(session.id);
    cad = createFabCad({ bridge: () => client, clientName: "fabdesk/native-package-reopen" });
    const reopened = await cad.model(project);
    assert(reopened.objects.some((o) => o.name === "Enclosure"));
    assert.equal(
      Math.round(reopened.objects.find((o) => o.name === "Enclosure")!.bbox!.max[0]),
      40,
    );
    console.log(
      JSON.stringify({
        engine: "native",
        version: info.stdout.trim(),
        fcstdBytes: bytes.length,
        stepBytes: step.data.length,
        reopen: "pass",
        authentication: "pass",
        modules: ["Part", "Sketcher", "PartDesign"],
      }),
    );
  } finally {
    await cad?.dispose();
    await supervisor.stop();
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) await smokeCadBundle(process.argv[2] ?? "dist/cad/darwin-arm64/bundle.json");
