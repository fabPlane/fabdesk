#!/usr/bin/env bun
/** Nightly QA: an actual constrained 40 x 20 mm sketch, padded 10 mm, saved/reopened/exported. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { verifyCadMacApp } from "../apps/desktop/src/main/cad-runtime-mac";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, release as osRelease } from "node:os";
import { join, resolve } from "node:path";
import { CadSupervisor, resolveCadBackend } from "../apps/desktop/src/main/cad-supervisor";
import { FabCadBridgeClient } from "../apps/core/src/fab-cad-bridge";
import { createFabCad } from "../apps/core/src/fab-cad";

export async function smokeCadDrawing(
  manifest: string,
  allowUnsignedDevelopment = false,
): Promise<void> {
  if (
    !allowUnsignedDevelopment &&
    (process.platform !== "darwin" ||
      process.arch !== "arm64" ||
      Number(osRelease().split(".")[0]) < 24)
  )
    throw new Error(
      "CAD drawing QA currently requires an ARM64 Apple Silicon Mac on macOS 15 or later; unsupported is not a mock pass",
    );
  if (!existsSync(manifest))
    throw new Error(
      "CAD runtime missing: complete the consented first-use download before drawing QA; no mock pass is allowed",
    );
  if (!allowUnsignedDevelopment) await verifyCadMacApp(resolve(dirname(manifest), "../../.."));
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
    const drawing = await cad.python(
      project,
      `
import json
body = App.ActiveDocument.addObject('PartDesign::Body', 'QA_Body')
sketch = body.newObject('Sketcher::SketchObject', 'QA_Profile')
points = [App.Vector(0,0,0), App.Vector(40,0,0), App.Vector(40,20,0), App.Vector(0,20,0)]
for i in range(4): sketch.addGeometry(Part.LineSegment(points[i], points[(i+1)%4]))
constraints = [Sketcher.Constraint('Coincident', i, 2, (i+1)%4, 1) for i in range(4)]
constraints += [Sketcher.Constraint('Horizontal',0), Sketcher.Constraint('Vertical',1), Sketcher.Constraint('Horizontal',2), Sketcher.Constraint('Vertical',3)]
constraints += [Sketcher.Constraint('Distance',0,40.0), Sketcher.Constraint('Distance',1,20.0), Sketcher.Constraint('Coincident',0,1,-1,1)]
sketch.addConstraint(constraints)
pad = body.newObject('PartDesign::Pad', 'QA_Pad')
pad.Profile = sketch
pad.Length = 10
App.ActiveDocument.recompute()
assert sketch.GeometryCount == 4
assert pad.Shape.isValid()
assert len(pad.Shape.Solids) == 1
bbox = pad.Shape.BoundBox
assert abs(bbox.XLength-40) < 1e-6 and abs(bbox.YLength-20) < 1e-6 and abs(bbox.ZLength-10) < 1e-6
assert abs(pad.Shape.Volume-8000) < 1e-5
print(json.dumps({'dimensionsMm':[bbox.XLength,bbox.YLength,bbox.ZLength],'volumeMm3':pad.Shape.Volume,'sketchLines':sketch.GeometryCount,'constraints':sketch.ConstraintCount}))
`,
      "exec",
    );
    assert(!drawing.exception, JSON.stringify(drawing));
    const metrics = JSON.parse(drawing.stdout.trim());
    assert.deepEqual((await cad.recompute(project)).errors, []);
    await cad.save(project);
    const modelPath = join(project, "model.FCStd");
    const bytes = await readFile(modelPath);
    assert.equal(
      bytes.subarray(0, 2).toString(),
      "PK",
      "FCStd must be a real ZIP document, not mock JSON",
    );
    const step = await cad.export(project, { format: "step", objects: ["QA_Pad"] });
    assert(
      new TextDecoder().decode(step.data).includes("ISO-10303-21"),
      "STEP must contain real OCCT geometry",
    );
    assert(step.data.length > 500);
    const stepPath = join(project, "model.step");
    await writeFile(stepPath, step.data);
    const imported = await cad.python(
      project,
      `shape=Part.read(${JSON.stringify(stepPath)})\nassert shape.isValid()\nassert len(shape.Solids)==1\nassert abs(shape.Volume-8000)<1e-4\nprint(shape.Volume)`,
      "exec",
    );
    assert(!imported.exception, JSON.stringify(imported));
    const sessions = await client.sessions();
    await cad.dispose();
    cad = undefined;
    for (const session of sessions) await client.deleteSession(session.id);
    cad = createFabCad({ bridge: () => client, clientName: "fabdesk/native-package-reopen" });
    const reopened = await cad.model(project);
    assert(reopened.objects.some((o) => o.name === "QA_Profile"));
    assert(reopened.objects.some((o) => o.name === "QA_Pad"));
    assert.equal(Math.round(reopened.objects.find((o) => o.name === "QA_Pad")!.bbox!.max[0]), 40);
    const persisted = await cad.python(
      project,
      "assert App.ActiveDocument.QA_Profile.GeometryCount==4\nassert abs(App.ActiveDocument.QA_Pad.Shape.Volume-8000)<1e-5\nprint(App.ActiveDocument.QA_Pad.Shape.Volume)",
      "exec",
    );
    assert(!persisted.exception, JSON.stringify(persisted));
    console.log(
      JSON.stringify({
        engine: "native",
        runtimeTrust: allowUnsignedDevelopment
          ? "unsigned developer-only payload; not installation QA"
          : "Developer ID and notarization verified",
        drawing: metrics,
        stepReimport: "pass",
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

if (import.meta.main) {
  const manifest = process.argv[2];
  if (!manifest)
    throw new Error(
      "Pass the installed signed runtime bundle.json; first-use download must be tested separately",
    );
  await smokeCadDrawing(manifest, process.argv.includes("--allow-unsigned-development"));
}
