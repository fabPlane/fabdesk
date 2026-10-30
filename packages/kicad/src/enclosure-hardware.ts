import {
  portEnvelopes,
  type MechanicalDesign,
  type MechanicalFitIssue,
  type MechanicalBox,
} from "@fabdesk/protocol";
import type { EnclosureSolid } from "./enclosure";
import type { BoardFeatures } from "./board-features";
type Board = { placement: MechanicalDesign["boards"][number]; features: BoardFeatures };

/** Hardware geometry and its safety envelopes are generated together, so checks cannot drift. */
export function enclosureHardware(d: MechanicalDesign, boards: Board[]) {
  const solids: EnclosureSolid[] = [],
    issues: MechanicalFitIssue[] = [];
  const s = d.space,
    ceiling = s.floor + s.height;
  const add = (
    code: string,
    message: string,
    regions: MechanicalBox[] = [],
    severity: "error" | "review" = "error",
  ) => issues.push({ code, message, severity, ...(regions.length ? { regions } : {}) });
  const region = (solid: EnclosureSolid): MechanicalBox => ({
    name: solid.name,
    x: solid.min.x,
    y: solid.min.y,
    z: solid.min.z,
    width: solid.max.x - solid.min.x,
    depth: solid.max.y - solid.min.y,
    height: solid.max.z - solid.min.z,
  });
  const overlaps = (a: MechanicalBox, b: MechanicalBox) =>
    a.x < b.x + b.width - 1e-5 &&
    a.x + a.width > b.x + 1e-5 &&
    a.y < b.y + b.depth - 1e-5 &&
    a.y + a.depth > b.y + 1e-5 &&
    a.z < b.z + b.height - 1e-5 &&
    a.z + a.height > b.z + 1e-5;
  const world = (
    b: Board,
    r: { minX: number; minY: number; maxX: number; maxY: number },
    z: number,
    height: number,
    name: string,
  ): MechanicalBox => {
    const a = (b.placement.rotation * Math.PI) / 180;
    const points = [r.minX, r.maxX].flatMap((x) =>
      [r.minY, r.maxY].map((y) => [
        b.placement.x + x * Math.cos(a) - y * Math.sin(a),
        b.placement.y + x * Math.sin(a) + y * Math.cos(a),
      ]),
    );
    const xs = points.map((p) => p[0]!),
      ys = points.map((p) => p[1]!);
    return {
      name,
      x: Math.min(...xs),
      y: Math.min(...ys),
      z,
      width: Math.max(...xs) - Math.min(...xs),
      depth: Math.max(...ys) - Math.min(...ys),
      height,
    };
  };
  const components = boards.flatMap((b) =>
    (b.features.components ?? []).map((p) =>
      world(
        b,
        p.bounds,
        p.bottom ? b.placement.z - p.heightMm : b.placement.z + b.features.thicknessMm,
        p.heightMm,
        `${b.placement.path}: ${p.ref}`,
      ),
    ),
  );
  const pcbs = boards.map((b) =>
    world(b, b.features.outline, b.placement.z, b.features.thicknessMm, b.placement.path),
  );
  const mounts: MechanicalBox[] = d.mounts.map((m, i) => ({
    name: `Mounting post ${i + 1}`,
    x: m.x - m.outer / 2,
    y: m.y - m.outer / 2,
    z: s.floor,
    width: m.outer,
    depth: m.outer,
    height: m.height,
  }));
  const plugs = portEnvelopes(d, boards).flatMap((p) => (p.plug ? [p.plug] : []));
  const openings: MechanicalBox[] = d.openings.map((o) => {
    const vertical = o.wall.endsWith("X"),
      negative = o.wall.startsWith("min");
    const wall = vertical ? (negative ? s.x : s.x + s.width) : negative ? s.y : s.y + s.depth;
    return {
      name: o.name,
      x: vertical ? wall - s.wall : o.offset - o.width / 2,
      y: vertical ? o.offset - o.width / 2 : wall - s.wall,
      z: o.z,
      width: vertical ? s.wall * 2 : o.width,
      depth: vertical ? o.width : s.wall * 2,
      height: o.height,
    };
  });
  if (d.mode !== "generated" && (d.holders?.length || d.closure?.kind === "screws"))
    add(
      "hardware-mode",
      "Automatic lid screws and corner holders currently require a generated case.",
    );
  if (d.closure?.kind === "screws") {
    const c = d.closure,
      r = c.bossDiameter / 2;
    if (
      c.pilotDiameter >= c.screwDiameter ||
      c.clearanceDiameter <= c.screwDiameter ||
      c.bossDiameter - c.clearanceDiameter < 3
    )
      add(
        "closure-size",
        "Lid screws need a smaller pilot, a larger clearance hole, and at least 1.5 mm of material around each hole.",
      );
    const engagement = c.screwLength - s.lid;
    if (engagement < c.screwDiameter * 2 || engagement > s.height - 1)
      add(
        "closure-length",
        "Lid screw engagement must be at least two screw diameters, with 1 mm remaining above the floor.",
      );
    const candidates: Array<Array<[number, number]>> = [];
    // Search a bounded set of positions along both wall pairs. Keep four lugs
    // separated, preferring the corners unless a port needs that space.
    const offsets = (length: number) =>
      Array.from({ length: 9 }, (_, i) => r + 1 + ((length / 2 - 2 * r - 2) * i) / 8);
    if (s.depth >= c.bossDiameter * 2 + 4)
      for (const offset of offsets(s.depth))
        candidates.push(
          [s.x - s.wall - r + 0.8, s.x + s.width + s.wall + r - 0.8].flatMap((x) =>
            [s.y + offset, s.y + s.depth - offset].map((y) => [x, y] as [number, number]),
          ),
        );
    if (s.width >= c.bossDiameter * 2 + 4)
      for (const offset of offsets(s.width))
        candidates.push(
          [s.y - s.wall - r + 0.8, s.y + s.depth + s.wall + r - 0.8].flatMap((y) =>
            [s.x + offset, s.x + s.width - offset].map((x) => [x, y] as [number, number]),
          ),
        );
    const access = [...plugs, ...openings, ...components, ...pcbs, ...d.obstacles];
    const conflicts = (points: Array<[number, number]>) =>
      points.reduce(
        (n, [x, y]) =>
          n +
          access.filter((a) =>
            overlaps(
              {
                name: "Lid screw",
                x: x - r,
                y: y - r,
                z: 0,
                width: r * 2,
                depth: r * 2,
                height: ceiling + s.lid,
              },
              a,
            ),
          ).length,
        0,
      );
    const positions =
      candidates
        .map((points) => ({ points, score: conflicts(points) }))
        .sort((a, b) => a.score - b.score)[0]?.points ?? [];
    if (!positions.length)
      add("closure-size", "The case is too small for four separate screw lugs.");
    for (const [i, [x, y]] of positions.entries()) {
      for (const lid of [false, true])
        solids.push({
          name: `LidScrew${i}${lid ? "Lid" : "Base"}`,
          kind: "cylinder",
          role: lid ? "lid" : "wall",
          radiusMm: r,
          innerRadiusMm: (lid ? c.clearanceDiameter : c.pilotDiameter) / 2,
          min: { x: x - r, y: y - r, z: lid ? ceiling : 0 },
          max: { x: x + r, y: y + r, z: lid ? ceiling + s.lid : ceiling },
        });
    }
    add(
      "closure-material",
      "Lid screw pilots are for tapping or suitable plastic screws. Confirm your screw type and material on a printed sample before assembly.",
      [],
      "review",
    );
  }
  for (const holder of d.holders ?? []) {
    const b = boards.find((b) => b.placement.path === holder.boardPath);
    if (!b) {
      add("holder-board", `${holder.boardPath}: holder refers to a missing board.`);
      continue;
    }
    if (
      !b.features.outline.closed ||
      b.features.warnings.some((w) => /non-rectangular/i.test(w)) ||
      Math.abs(b.placement.rotation / 90 - Math.round(b.placement.rotation / 90)) > 1e-5
    ) {
      add(
        "holder-outline",
        `${holder.boardPath}: automatic corner holders require a closed rectangular board at a quarter-turn rotation.`,
      );
      continue;
    }
    const pcb = pcbs[boards.indexOf(b)]!,
      pad = 2.5,
      gap = 0.25,
      wall = 1.5;
    if (
      pcb.width < 2 * pad + 2 ||
      pcb.depth < 2 * pad + 2 ||
      pcb.z <= s.floor ||
      pcb.z + pcb.height + gap >= ceiling
    ) {
      add(
        "holder-room",
        `${holder.boardPath}: not enough space above or below the board for corner holders.`,
      );
      continue;
    }
    for (const right of [false, true])
      for (const back of [false, true]) {
        const x = right ? pcb.x + pcb.width - pad : pcb.x,
          y = back ? pcb.y + pcb.depth - pad : pcb.y;
        const fenceX = right ? pcb.x + pcb.width + gap : pcb.x - gap - wall;
        const fenceY = back ? pcb.y + pcb.depth + gap : pcb.y - gap - wall;
        const name = `${holder.boardPath} corner ${Number(right)}${Number(back)}`;
        const box = (
          suffix: string,
          role: "standoff" | "lid",
          x0: number,
          y0: number,
          z0: number,
          x1: number,
          y1: number,
          z1: number,
        ) => {
          const solid: EnclosureSolid = {
            name: name + suffix,
            kind: "box",
            role,
            min: { x: x0, y: y0, z: z0 },
            max: { x: x1, y: y1, z: z1 },
          };
          // Safe STEP entity labels: filenames remain only in issue messages.
          solid.name = `CornerHolder${solids.length}`;
          const r = region(solid);
          if (
            r.x < s.x ||
            r.y < s.y ||
            r.x + r.width > s.x + s.width ||
            r.y + r.depth > s.y + s.depth
          )
            add("holder-room", `${name}: move the board farther from the wall.`, [r]);
          for (const p of [
            ...components,
            ...pcbs.filter((p) => p.name !== holder.boardPath),
            ...d.obstacles,
            ...mounts,
          ])
            if (overlaps(r, p))
              add(
                "holder-collision",
                `${name}: holder would touch ${p.name}. Use mounting holes or move parts away from the corners.`,
                [r, p],
              );
          solids.push(solid);
        };
        // Foot supports the edge; two fences restrain XY; a lid peg captures the top with 0.25 mm play.
        box(
          "foot",
          "standoff",
          Math.min(x, fenceX),
          Math.min(y, fenceY),
          s.floor,
          Math.max(x + pad, fenceX + wall),
          Math.max(y + pad, fenceY + wall),
          pcb.z,
        );
        box(
          "x-fence",
          "standoff",
          fenceX,
          Math.min(y, fenceY),
          pcb.z,
          fenceX + wall,
          Math.max(y + pad, fenceY + wall),
          pcb.z + pcb.height + gap,
        );
        box(
          "y-fence",
          "standoff",
          Math.min(x, fenceX),
          fenceY,
          pcb.z,
          Math.max(x + pad, fenceX + wall),
          fenceY + wall,
          pcb.z + pcb.height + gap,
        );
        box("capture", "lid", x, y, pcb.z + pcb.height + gap, x + pad, y + pad, ceiling + s.lid);
      }
    if (d.closure?.kind !== "screws")
      add("holder-closure", "Corner holders need a screwed lid to retain the board.");
    add(
      "holder-review",
      `${holder.boardPath}: verify 2.5 mm clear corners, solder joints, underside parts and 0.25 mm holder play on a printed sample.`,
      [],
      "review",
    );
  }
  for (const solid of solids) {
    const r = region(solid);
    for (const access of [
      ...plugs,
      ...openings,
      ...(solid.name.startsWith("LidScrew") ? [...components, ...pcbs, ...d.obstacles] : []),
    ])
      if (overlaps(r, access))
        add(
          "hardware-access",
          `${access.name}: enclosure hardware blocks the opening or plug access. Change the layout or retention method.`,
          [r, access],
        );
  }
  return { solids, issues };
}
