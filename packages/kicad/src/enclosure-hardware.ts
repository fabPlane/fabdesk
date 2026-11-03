import {
  portEnvelopes,
  chooseLidScrews,
  enclosureOpeningBounds,
  type MechanicalDesign,
  type MechanicalFitIssue,
  type MechanicalBox,
} from "@fabdesk/protocol";
import type { EnclosureSolid } from "./enclosure";
import type { BoardFeatures } from "./board-features";
import { edgeHolderFit, findEdgeHolders } from "./enclosure-edge-holders";
type Board = { placement: MechanicalDesign["boards"][number]; features: BoardFeatures };

/** Hardware geometry and its safety envelopes are generated together, so checks cannot drift. */
export function enclosureHardware(d: MechanicalDesign, boards: Board[]) {
  const solids: EnclosureSolid[] = [],
    issues: MechanicalFitIssue[] = [];
  const s = d.space,
    allowance = d.fitAllowance ?? 0,
    errorGap = 2 * allowance,
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
    a.x < b.x + b.width + errorGap - 1e-5 &&
    a.x + a.width + errorGap > b.x + 1e-5 &&
    a.y < b.y + b.depth + errorGap - 1e-5 &&
    a.y + a.depth + errorGap > b.y + 1e-5 &&
    a.z < b.z + b.height + errorGap - 1e-5 &&
    a.z + a.height + errorGap > b.z + 1e-5;
  if (allowance > 0)
    add(
      "fit-allowance",
      `Checks reserve ${errorGap.toFixed(2)} mm between opposing surfaces (±${allowance.toFixed(2)} mm each). Edge holders, lid rim and newly arranged port openings include this allowance; review existing openings. This is a dimensional assumption, not verified printer accuracy, material strength or missing-model coverage.`,
      [],
      "review",
    );
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
  const openings = enclosureOpeningBounds(d);
  if (d.mode !== "generated" && (d.holders?.length || d.closure?.kind === "screws"))
    add(
      "hardware-mode",
      "Automatic lid screws and board holders currently require a generated case.",
    );
  if (d.closure?.kind === "screws") {
    const c = d.closure,
      r = c.bossDiameter / 2;
    if (
      c.pilotDiameter + errorGap >= c.screwDiameter ||
      c.clearanceDiameter - errorGap <= c.screwDiameter ||
      c.bossDiameter - c.clearanceDiameter - 4 * allowance < 3
    )
      add(
        "closure-size",
        "Lid screws need a smaller pilot, a larger clearance hole, and at least 1.5 mm of material around each hole after the selected dimensional allowance.",
      );
    const engagement = c.screwLength - s.lid;
    if (engagement - errorGap < c.screwDiameter * 2 || engagement + errorGap > s.height - 1)
      add(
        "closure-length",
        "Lid screw engagement must remain at least two screw diameters, with 1 mm above the floor, after the selected dimensional allowance. Check screw length and lid thickness.",
      );
    // Search a bounded set of positions along both wall pairs. Keep four lugs
    // separated, preferring the corners unless a port needs that space.
    const access = [...plugs, ...openings, ...components, ...pcbs, ...d.obstacles];
    // Keep conflicting hardware visible when no valid arrangement exists; fit checks block export.
    const positions = chooseLidScrews(d, access).points;
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
        `${holder.boardPath}: automatic holders require a closed rectangular board at a quarter-turn rotation.`,
      );
      continue;
    }
    const pcb = pcbs[boards.indexOf(b)]!,
      pad = 2.5,
      gap = holder.kind === "edge-clamps" ? edgeHolderFit(allowance).play : 0.25,
      wall = 1.5;
    if (
      pcb.width < 2 * pad + 2 ||
      pcb.depth < 2 * pad + 2 ||
      pcb.z <= s.floor ||
      pcb.z + pcb.height + gap >= ceiling
    ) {
      add(
        "holder-room",
        `${holder.boardPath}: not enough space above or below the board for holders.`,
      );
      continue;
    }
    if (d.closure?.kind !== "screws")
      add("holder-closure", "Board holders need a screwed lid to retain the board.");
    if (holder.kind === "edge-clamps") {
      const keepouts = [
        ...components,
        ...pcbs.filter((p) => p.name !== holder.boardPath),
        ...d.obstacles,
        ...mounts,
        ...plugs,
        ...openings,
        ...solids.map(region),
        ...b.features.holes.map((h) =>
          world(
            b,
            {
              minX: h.x - (h.drillWidthMm ?? h.diameterMm) / 2 - 0.25,
              maxX: h.x + (h.drillWidthMm ?? h.diameterMm) / 2 + 0.25,
              minY: h.y - (h.drillHeightMm ?? h.diameterMm) / 2 - 0.25,
              maxY: h.y + (h.drillHeightMm ?? h.diameterMm) / 2 + 0.25,
            },
            s.floor,
            s.height,
            `${holder.boardPath}: ${h.id}`,
          ),
        ),
      ];
      const found = findEdgeHolders(
        pcb,
        s,
        (solid) => {
          const r = region(solid);
          return (
            r.width > 0 &&
            r.depth > 0 &&
            r.height > 0 &&
            r.x >= s.x + errorGap &&
            r.y >= s.y + errorGap &&
            r.x + r.width <= s.x + s.width - errorGap &&
            r.y + r.depth <= s.y + s.depth - errorGap &&
            !keepouts.some((p) => overlaps(r, p))
          );
        },
        allowance,
      );
      if (!found)
        add(
          "holder-space",
          `${holder.boardPath}: no clear, distributed edge supports and end stops were found. Leave clear strips near the edges, change the layout, or use a custom restraint.`,
          [pcb],
        );
      else {
        for (const solid of found) solids.push({ ...solid, name: `${solid.name}${solids.length}` });
        const foot = found.find((solid) => solid.name === "EdgeFence")!;
        const contactLength = Math.max(foot.max.x - foot.min.x, foot.max.y - foot.min.y);
        add(
          "holder-review",
          `${holder.boardPath}: four edge supports and lid captures avoid known keepouts. ${edgeHolderFit(allowance).play.toFixed(2)} mm play and ${edgeHolderFit(allowance).capture.toFixed(2)} mm capture lips retain 0.25 mm calculated engagement at maximum play and selected surface error. Verify 2 × ${contactLength.toFixed(0)} mm underside contact strips, solder clearance and strength under plug insertion on a printed sample.`,
          [],
          "review",
        );
      }
      continue;
    }
    if (allowance > 0)
      add(
        "holder-tolerance",
        "Corner holders do not support dimensional allowance. Choose Find clear edges, or use custom retention.",
        [pcb],
      );
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
