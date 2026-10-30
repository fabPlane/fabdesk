import Module, { type Manifold, type ManifoldToplevel } from "manifold-3d";
// @ts-expect-error Bun embeds this asset in the compiled daemon.
import wasmPath from "manifold-3d/manifold.wasm" with { type: "file" };
import { asciiStl, writeBoxesStep, type EnclosureSpec } from "./enclosure";
import { profileTriangles, profileWall, type Triangle } from "./enclosure-profile";
import type { MechanicalDesign } from "@fabdesk/protocol";
export type { Manifold } from "manifold-3d";

let ready: Promise<ManifoldToplevel> | undefined;
export function solidKernel() {
  ready ??= Bun.file(wasmPath)
    .arrayBuffer()
    .then(async (wasmBinary) => {
      // Emscripten accepts wasmBinary; the package's declaration only lists locateFile.
      const config = { wasmBinary, locateFile: () => wasmPath };
      const m = await Module(config);
      m.setup();
      return m;
    })
    .catch((error) => {
      ready = undefined;
      throw error;
    });
  return ready;
}

export type SolidCheck = { closed: true; components: number; volumeMm3: number; triangles: number };
export function solidFromTriangles(k: ManifoldToplevel, triangles: ArrayLike<number>) {
  if (!triangles.length || triangles.length % 9 || triangles.length > 2_250_000)
    throw new Error("Detailed solid must contain 1–250,000 complete triangles.");
  const vertices: number[] = [],
    indices: number[] = [],
    ids = new Map<string, number>();
  for (let i = 0; i < triangles.length; i += 3) {
    const p = [triangles[i]!, triangles[i + 1]!, triangles[i + 2]!].map(Math.fround);
    if (!p.every(Number.isFinite)) throw new Error("Invalid solid coordinates");
    const key = p.join(",");
    let id = ids.get(key);
    if (id === undefined) {
      id = vertices.length / 3;
      ids.set(key, id);
      vertices.push(...p);
    }
    indices.push(id);
  }
  const mesh = new k.Mesh({
    numProp: 3,
    vertProperties: new Float32Array(vertices),
    triVerts: new Uint32Array(indices),
  });
  mesh.merge();
  return new k.Manifold(mesh);
}
export function solidTriangles(solid: Manifold): Triangle[] {
  const mesh = solid.getMesh(),
    triangles: Triangle[] = [];
  const point = (i: number) => ({
    x: mesh.vertProperties[i * mesh.numProp]!,
    y: mesh.vertProperties[i * mesh.numProp + 1]!,
    z: mesh.vertProperties[i * mesh.numProp + 2]!,
  });
  for (let i = 0; i < mesh.triVerts.length; i += 3)
    triangles.push([
      point(mesh.triVerts[i]!),
      point(mesh.triVerts[i + 1]!),
      point(mesh.triVerts[i + 2]!),
    ]);
  return triangles;
}

export function inspectSolid(solid: Manifold, label: string): SolidCheck {
  if (
    solid.status() !== "NoError" ||
    solid.isEmpty() ||
    !Number.isFinite(solid.volume()) ||
    solid.volume() <= 0
  )
    throw new Error(
      `${label}: could not form a closed solid. Review openings and wall dimensions.`,
    );
  const parts = solid.decompose();
  try {
    if (parts.length !== 1)
      throw new Error(
        `${label}: ${parts.length} disconnected pieces. Reduce openings or reconnect the unsupported pieces before exporting.`,
      );
    return {
      closed: true,
      components: parts.length,
      volumeMm3: solid.volume(),
      triangles: solid.numTri(),
    };
  } finally {
    for (const p of parts) p.delete();
  }
}

export async function auditStl(bytes: Uint8Array) {
  const { readStlTriangles } = await import("./shell-fit");
  const k = await solidKernel(),
    shape = solidFromTriangles(k, readStlTriangles(bytes));
  try {
    return inspectSolid(shape, "Imported case");
  } finally {
    shape.delete();
  }
}

/** Small, separate print coupons let users test tolerances before spending a full case. */
export async function enclosureFitSamples(d: MechanicalDesign) {
  const k = await solidKernel(),
    files: Record<string, string> = {},
    owned: Manifold[] = [];
  const own = (s: Manifold) => {
    owned.push(s);
    return s;
  };
  const guide = [
    "FIT SAMPLES — millimetres; print using the case's material and settings.",
    "These samples check local fit only, not full assembly strength, cooling or cable routing.",
  ];
  try {
    for (const [i, o] of d.openings.entries()) {
      const w = o.width + 6,
        h = o.height + 6;
      const wall = profileWall(
        "Sample",
        "minY",
        { min: { x: 0, y: 0, z: 0 }, max: { x: w, y: d.space.wall, z: h } },
        [],
        [
          {
            ref: o.name,
            edge: "minY",
            center: { x: w / 2, y: 0, z: h / 2 },
            widthMm: o.width,
            heightMm: o.height,
            ...(o.shape ? { shape: o.shape } : {}),
            connector: { x: 0, y: 0, widthMm: o.width, heightMm: o.height },
          },
        ],
      );
      const raw = profileTriangles(wall[0]!).flatMap((t) => t.flatMap((p) => [p.x, p.y, p.z]));
      const native = own(solidFromTriangles(k, raw)),
        flat = own(own(native.rotate([90, 0, 0])).translate([0, h, 0]));
      inspectSolid(flat, "Opening sample");
      const file = `fit-samples/port-${String(i + 1).padStart(2, "0")}.stl`;
      files[file] = asciiStl("port_fit_sample", solidTriangles(flat));
      guide.push(
        `${file}: ${o.name}, ${o.width} × ${o.height} mm ${o.shape ?? "rectangle"}, ${d.space.wall} mm thick. Test the actual plug/card and confirm insertion/removal.`,
      );
    }
    if (d.mode === "generated" && d.closure?.kind === "screws") {
      let sample = own(k.Manifold.cube([30, 12, 8]));
      const diameters = [
        d.closure.pilotDiameter - 0.1,
        d.closure.pilotDiameter,
        d.closure.pilotDiameter + 0.1,
      ];
      for (const [i, diameter] of diameters.entries()) {
        const bore = own(
          own(k.Manifold.cylinder(10, diameter / 2, diameter / 2, 64)).translate([
            5 + i * 10,
            6,
            -1,
          ]),
        );
        sample = own(sample.subtract(bore));
      }
      inspectSolid(sample, "Pilot sample");
      files["fit-samples/screw-pilots.stl"] = asciiStl(
        "screw_pilot_sample",
        solidTriangles(sample),
      );
      guide.push(
        `screw-pilots.stl: three holes along the long edge. Left to right in model coordinates: ${diameters.map((n) => n.toFixed(2)).join(", ")} mm. Test your screw without forcing it, then enter the best measured pilot size and regenerate the case.`,
      );
    }
    if (Object.keys(files).length) files["fit-samples/README.txt"] = guide.join("\n");
    return files;
  } finally {
    for (const s of owned.reverse()) s.delete();
  }
}

/** Build each primitive as a closed solid, then boolean-union each printable part. */
export async function joinedEnclosure(spec: EnclosureSpec) {
  const k = await solidKernel();
  const owned: Manifold[] = [];
  const own = (s: Manifold) => {
    owned.push(s);
    return s;
  };
  try {
    const base: Manifold[] = [],
      lid: Manifold[] = [];
    for (const s of spec.solids) {
      let shape: Manifold;
      if (s.kind === "profile") {
        const vertices: number[] = [],
          indices: number[] = [],
          ids = new Map<string, number>();
        for (const triangle of profileTriangles(s))
          for (const p of triangle) {
            const coords = [p.x, p.y, p.z].map(Math.fround),
              key = coords.join(",");
            let id = ids.get(key);
            if (id === undefined) {
              id = vertices.length / 3;
              ids.set(key, id);
              vertices.push(...coords);
            }
            indices.push(id);
          }
        shape = own(
          new k.Manifold(
            new k.Mesh({
              numProp: 3,
              vertProperties: new Float32Array(vertices),
              triVerts: new Uint32Array(indices),
            }),
          ),
        );
      } else if (s.kind === "cylinder" && s.radiusMm) {
        const x = (s.min.x + s.max.x) / 2,
          y = (s.min.y + s.max.y) / 2;
        const stand = spec.standoffs.find(
          (h) => Math.abs(h.x - x) < 1e-6 && Math.abs(h.y - y) < 1e-6,
        );
        const height = s.max.z - s.min.z;
        const outer = own(k.Manifold.cylinder(height, s.radiusMm, s.radiusMm, 64));
        const inner = own(
          k.Manifold.cylinder(
            height + 2,
            s.innerRadiusMm ?? (stand?.innerDiameterMm ?? s.radiusMm * 0.5) / 2,
            undefined,
            64,
          ),
        );
        const bore = own(inner.translate([0, 0, -1]));
        shape = own(own(outer.subtract(bore)).translate([x, y, s.min.z]));
      } else {
        shape = own(
          own(k.Manifold.cube([s.max.x - s.min.x, s.max.y - s.min.y, s.max.z - s.min.z])).translate(
            [s.min.x, s.min.y, s.min.z],
          ),
        );
      }
      if (shape.status() !== "NoError") throw new Error(`Invalid enclosure part: ${s.name}`);
      (s.role === "lid" || s.role === "lip" ? lid : base).push(shape);
    }
    const baseSolid = own(k.Manifold.union(base)),
      lidSolid = own(k.Manifold.union(lid));
    const validation = {
      engine: "manifold-3d 3.5.4",
      base: inspectSolid(baseSolid, "Case"),
      lid: inspectSolid(lidSolid, "Lid"),
      physicalFitVerified: false,
    };
    const bt = solidTriangles(baseSolid),
      lt = solidTriangles(lidSolid);
    const printLid = own(
      own(lidSolid.rotate([180, 0, 0])).translate([0, 0, lidSolid.boundingBox().max[2]]),
    );
    return {
      baseStl: asciiStl("fabplane_enclosure_base", bt),
      lidStl: asciiStl("fabplane_enclosure_lid", lt),
      step: writeBoxesStep(
        [],
        [],
        [
          { name: "Case", triangles: bt },
          { name: "Lid", triangles: lt },
        ],
      ),
      lidPrintStl: asciiStl("fabplane_lid_print", solidTriangles(printLid)),
      validation,
    };
  } finally {
    for (const shape of owned.reverse()) shape.delete();
  }
}
