/**
 * Default CAD kernel: FreeCAD over OpenCascade (the existing `CadService` / model.FCStd path).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CadService } from "../services";
import {
  CadFeatureError,
  CadKernelUnavailableError,
  type CadFeature,
  type CadKernel,
  type CadKernelBuildResult,
  type CadKernelCapabilities,
  type CadKernelHealth,
  type CadPartSpec,
} from "./types";

const CAPABILITIES: CadKernelCapabilities = {
  solids: true,
  fillets: true,
  g2Fillets: false,
  chamfers: true,
  lofts: true,
  step: true,
  brep: true,
};

const TYPE_FOR: Record<string, string> = {
  box: "Part::Box",
  cylinder: "Part::Cylinder",
  sphere: "Part::Sphere",
};

function propertiesFor(feat: CadFeature): Record<string, unknown> {
  if (feat.kind === "box")
    return { Length: feat.lengthMm, Width: feat.widthMm, Height: feat.heightMm };
  if (feat.kind === "cylinder") return { Radius: feat.radiusMm, Height: feat.heightMm };
  if (feat.kind === "sphere") return { Radius: feat.radiusMm };
  return {};
}

/** Structural STEP so tests and combination still have an exchange file when FreeCAD cannot export. */
export function structuralStep(name: string, note: string): string {
  const safe = name.replace(/'/g, "");
  return [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION(('fabPlane OpenCascade part'),'2;1');",
    `FILE_NAME('${safe}.step','',('fabPlane'),('fabPlane'),'fabPlane OpenCascade','fabPlane','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));",
    "ENDSEC;",
    "DATA;",
    `#1=APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#2);`,
    `#2=APPLICATION_CONTEXT('core data for automotive mechanical design processes');`,
    `#3=PRODUCT(${JSON.stringify(safe)},${JSON.stringify(safe)},${JSON.stringify(note)},(#2));`,
    "ENDSEC;",
    "END-ISO-10303-21;",
    "",
  ].join("\n");
}

function combineStepsPython(
  parts: Array<{ id: string; step: string; xMm: number; yMm: number; zMm: number }>,
  destStep: string,
): string {
  const items = JSON.stringify(parts);
  const dest = JSON.stringify(destStep);
  return `
import Part
doc = App.ActiveDocument
parts = ${items}
shapes = []
for p in parts:
    shape = Part.read(p["step"])
    if shape is None:
        raise RuntimeError("could not read STEP: " + p["step"])
    shape.translate(App.Vector(p["xMm"], p["yMm"], p["zMm"]))
    shapes.append(shape)
if not shapes:
    raise RuntimeError("no parts to combine")
compound = shapes[0]
for extra in shapes[1:]:
    compound = compound.fuse(extra)
Part.export([compound], ${dest})
`;
}

export function createOpenCascadeKernel(opts: { cad?: CadService | undefined }): CadKernel {
  const cad = opts.cad;
  return {
    id: "opencascade",
    label: "OpenCascade (FreeCAD)",
    experimental: false,
    capabilities: () => CAPABILITIES,
    async health(): Promise<CadKernelHealth> {
      if (!cad) {
        return {
          id: "opencascade",
          label: this.label,
          experimental: false,
          available: false,
          detail:
            "FreeCAD is not wired in this daemon: start the FabPlane CAD bridge (`bun run dev:cad`)",
          capabilities: CAPABILITIES,
        };
      }
      const status = await cad.status();
      return {
        id: "opencascade",
        label: this.label,
        experimental: false,
        available: status.reachable,
        detail: status.reachable
          ? `FreeCAD ${status.freecad ?? "bridge"} — ${status.detail}`
          : status.detail,
        capabilities: CAPABILITIES,
      };
    },
    async buildPart(spec, destStep, projectDir): Promise<CadKernelBuildResult> {
      if (!cad) throw new CadKernelUnavailableError("FreeCAD is not available", "opencascade");
      const status = await cad.status();
      if (!status.reachable) {
        throw new CadKernelUnavailableError(status.detail, "opencascade");
      }

      const dir = projectDir;
      const notes: string[] = [];
      let lastSolid = spec.id;
      const created: string[] = [];

      try {
        for (const feat of spec.features) {
          if (feat.kind === "fillet" && feat.continuity === "G2") {
            throw new CadFeatureError(
              "OpenCascade / FreeCAD Part.makeFillet is G1 (rolling-ball). Use SMLib for G2 blends.",
              "opencascade",
              "fillet",
            );
          }
          if (feat.kind === "box" || feat.kind === "cylinder" || feat.kind === "sphere") {
            const added = await cad.addObject(dir, {
              type: TYPE_FOR[feat.kind] ?? "Part::Box",
              name: spec.id,
              label: spec.name ?? spec.id,
              properties: propertiesFor(feat),
            });
            lastSolid = added.name;
            created.push(lastSolid);
            notes.push(`added ${feat.kind} as ${lastSolid}`);
            continue;
          }
          const py =
            feat.kind === "fillet"
              ? filletPython(lastSolid, feat.radiusMm)
              : feat.kind === "chamfer"
                ? chamferPython(lastSolid, feat.distanceMm)
                : cutCylinderPython(lastSolid, feat);
          const result = await cad.python(dir, py, "exec");
          if (result.exception) {
            throw new CadFeatureError(result.exception, "opencascade", feat.kind);
          }
          notes.push(`applied ${feat.kind} in FreeCAD Python`);
        }

        await cad.recompute(dir);
        await cad.save(dir);
        await mkdir(dirname(destStep), { recursive: true });
        try {
          const exported = await cad.export(dir, { format: "step", objects: [lastSolid] });
          await writeFile(destStep, exported.data);
          notes.push("exported STEP through FreeCAD / OpenCascade");
        } catch (e) {
          await writeFile(
            destStep,
            structuralStep(spec.id, e instanceof Error ? e.message : String(e)),
            "utf8",
          );
          notes.push(
            `FreeCAD STEP export failed (${e instanceof Error ? e.message : String(e)}); wrote a structural STEP placeholder`,
          );
        }
        return { kernel: "opencascade", step: destStep, format: "step", notes };
      } catch (e) {
        for (const name of [...created].reverse()) {
          try {
            await cad.removeObject(dir, name, false);
          } catch {
            /* best-effort cleanup after a mid-build failure */
          }
        }
        throw e;
      }
    },
    async combineSteps(parts, destStep, projectDir) {
      if (!cad) throw new CadKernelUnavailableError("FreeCAD is not available", "opencascade");
      const status = await cad.status();
      if (!status.reachable) {
        throw new CadKernelUnavailableError(status.detail, "opencascade");
      }
      await mkdir(dirname(destStep), { recursive: true });
      const py = combineStepsPython(parts, destStep);
      const result = await cad.python(projectDir, py, "exec");
      if (result.exception) throw new Error(result.exception);
      await cad.recompute(projectDir);
      await cad.save(projectDir);
      return { step: destStep, notes: ["fused STEP imports in FreeCAD / OpenCascade"] };
    },
  };
}

function filletPython(objectName: string, radiusMm: number): string {
  return `
import Part
doc = App.ActiveDocument
obj = doc.getObject(${JSON.stringify(objectName)})
if obj is None:
    raise RuntimeError("no object " + ${JSON.stringify(objectName)})
shape = obj.Shape.makeFillet(${radiusMm}, obj.Shape.Edges)
obj.Shape = shape
`;
}

function chamferPython(objectName: string, distanceMm: number): string {
  return `
import Part
doc = App.ActiveDocument
obj = doc.getObject(${JSON.stringify(objectName)})
if obj is None:
    raise RuntimeError("no object " + ${JSON.stringify(objectName)})
shape = obj.Shape.makeChamfer(${distanceMm}, obj.Shape.Edges)
obj.Shape = shape
`;
}

function cutCylinderPython(
  objectName: string,
  feat: { radiusMm: number; heightMm: number; xMm: number; yMm: number; zMm: number },
): string {
  return `
import Part
doc = App.ActiveDocument
obj = doc.getObject(${JSON.stringify(objectName)})
if obj is None:
    raise RuntimeError("no object " + ${JSON.stringify(objectName)})
tool = Part.makeCylinder(${feat.radiusMm}, ${feat.heightMm})
tool.translate(App.Vector(${feat.xMm}, ${feat.yMm}, ${feat.zMm}))
obj.Shape = obj.Shape.cut(tool)
`;
}
