import type { MechanicalBox, MechanicalDesign, MechanicalFitIssue } from "@fabdesk/protocol";
import type { EnclosureBoardSummary } from "./enclosure-design";
import { enclosureComponents } from "./enclosure-design";
import { fitIssueBoardPath } from "./enclosure-readiness";

type Placement = MechanicalDesign["boards"][number];
type Rect = { minX: number; minY: number; maxX: number; maxY: number };
type Point = [number, number, number];
export type EnclosureReviewBoard = {
  placement: Placement;
  features: EnclosureBoardSummary;
};
export type EnclosureReviewTarget = {
  kind: "regions" | "connector" | "component" | "board";
  point: Point;
  regions: MechanicalBox[];
  boardPath?: string;
  modelId?: string;
  reference?: string;
};

// These findings describe check coverage, not a physical defect at a particular part.
const unlocated = new Set([
  "verification-pending",
  "coverage",
  "import-coverage",
  "shell-coverage",
  "detailed-coverage",
  "detailed-layers",
  "assembly-sampled",
]);

function validRegion(region: MechanicalBox) {
  return (
    [region.x, region.y, region.z, region.width, region.depth, region.height].every(
      Number.isFinite,
    ) &&
    region.width > 0 &&
    region.depth > 0 &&
    region.height > 0
  );
}

function center(region: MechanicalBox): Point {
  return [region.x + region.width / 2, region.y + region.depth / 2, region.z + region.height / 2];
}

function worldPoint(placement: Placement, x: number, y: number, z: number): Point {
  const angle = (placement.rotation * Math.PI) / 180;
  return [
    placement.x + x * Math.cos(angle) - y * Math.sin(angle),
    placement.y + x * Math.sin(angle) + y * Math.cos(angle),
    placement.z + z,
  ];
}

function validRect(rect: Rect) {
  return (
    [rect.minX, rect.minY, rect.maxX, rect.maxY].every(Number.isFinite) &&
    rect.maxX > rect.minX &&
    rect.maxY > rect.minY
  );
}

/** Use only known bounds; a position alone does not justify an invented highlight volume. */
function worldBounds(
  placement: Placement,
  rect: Rect | undefined,
  z: number,
  height: number,
  name: string,
): MechanicalBox | null {
  if (!rect || !validRect(rect) || !Number.isFinite(height) || height <= 0) return null;
  const corners = [rect.minX, rect.maxX].flatMap((x) =>
    [rect.minY, rect.maxY].map((y) => worldPoint(placement, x, y, z)),
  );
  const x = Math.min(...corners.map((p) => p[0])),
    y = Math.min(...corners.map((p) => p[1]));
  const region = {
    name,
    x,
    y,
    z: placement.z + z,
    width: Math.max(...corners.map((p) => p[0])) - x,
    depth: Math.max(...corners.map((p) => p[1])) - y,
    height,
  };
  return validRegion(region) ? region : null;
}

function mentions(message: string, ref: string) {
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|[^A-Za-z0-9_.-])${escaped}(?=$|[^A-Za-z0-9_.-]|\\.(?![A-Za-z0-9_-]))`,
    "i",
  ).test(message);
}

/**
 * Resolve a review item to evidence-backed scene coordinates. Placement always comes from
 * the current design, because feature responses may carry an older board arrangement.
 * Unlocated checks deliberately return null instead of pointing at the case centre.
 */
export function enclosureReviewTarget(
  issue: MechanicalFitIssue,
  design: MechanicalDesign,
  boards: readonly EnclosureReviewBoard[],
): EnclosureReviewTarget | null {
  if (unlocated.has(issue.code)) return null;
  const paths = design.boards.map((board) => board.path);
  const boardPath = fitIssueBoardPath(issue.message, paths);
  const location = boardPath ? { boardPath, modelId: `@fit-${boardPath}` } : {};
  const explicit = issue.regions?.filter(validRegion) ?? [];
  if (explicit.length)
    return { kind: "regions", point: center(explicit[0]!), regions: explicit, ...location };
  if (!boardPath) return null;
  const placement = design.boards.find((board) => board.path === boardPath)!;
  const features = boards.find((board) => board.placement.path === boardPath)?.features;
  if (!features) return null;
  // Never mistake a reference in the filename (e.g. J2-adapter.kicad_pcb) for a named part.
  const message = issue.message.slice(boardPath.length);
  const components = enclosureComponents(features);
  const connectors =
    features.connectors?.filter((connector) => mentions(message, connector.ref)) ?? [];
  if (connectors.length) {
    const first = connectors[0]!;
    const points: Point[] = [];
    const regions: MechanicalBox[] = [];
    for (const connector of connectors) {
      const bounds = connector.face?.bounds ?? connector.bounds;
      const bottom = components.some((part) => part.ref === connector.ref && part.bottom);
      const height = connector.face?.heightMm ?? connector.heightMm;
      const centerZ = connector.face?.centerZ ?? height / 2;
      const baseZ = bottom ? -centerZ - height / 2 : features.thicknessMm + centerZ - height / 2;
      let x = connector.x,
        y = connector.y;
      if (bounds && validRect(bounds)) {
        x = (bounds.minX + bounds.maxX) / 2;
        y = (bounds.minY + bounds.maxY) / 2;
        // Aim at the connector mouth, not the footprint/pad origin or the enclosure wall.
        if (connector.edge === "minX") x = bounds.minX;
        if (connector.edge === "maxX") x = bounds.maxX;
        if (connector.edge === "minY") y = bounds.minY;
        if (connector.edge === "maxY") y = bounds.maxY;
      }
      points.push(worldPoint(placement, x, y, bottom ? -centerZ : features.thicknessMm + centerZ));
      const region = worldBounds(placement, bounds, baseZ, height, connector.ref);
      if (region) regions.push(region);
    }
    if (points[0]!.every(Number.isFinite))
      return { kind: "connector", point: points[0]!, regions, reference: first.ref, ...location };
  }
  const parts = components.filter((part) => mentions(message, part.ref));
  if (parts.length) {
    const first = parts[0]!;
    const point = worldPoint(
      placement,
      first.x,
      first.y,
      first.bottom ? -first.heightMm / 2 : features.thicknessMm + first.heightMm / 2,
    );
    const regions = parts.flatMap((part) => {
      const region = worldBounds(
        placement,
        part.bounds,
        part.bottom ? -part.heightMm : features.thicknessMm,
        part.heightMm,
        part.ref,
      );
      return region ? [region] : [];
    });
    if (point.every(Number.isFinite))
      return { kind: "component", point, regions, reference: first.ref, ...location };
  }
  const bounds = worldBounds(placement, features.outline, 0, features.thicknessMm, "PCB");
  return bounds ? { kind: "board", point: center(bounds), regions: [bounds], ...location } : null;
}
