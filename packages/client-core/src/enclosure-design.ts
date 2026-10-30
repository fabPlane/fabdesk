import type { MechanicalDesign } from "@fabdesk/protocol";

export type EnclosureBoardSummary = {
  pcbRevision: string;
  thicknessMm: number;
  outline: {
    closed?: boolean;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    widthMm: number;
    heightMm: number;
  };
  warnings?: string[];
  holes: Array<{
    id?: string;
    x: number;
    y: number;
    diameterMm: number;
    ref?: string;
    purpose?: "mounting" | "component" | "unclassified";
    shape?: "round" | "slot";
    source?: string;
    drillWidthMm?: number;
    drillHeightMm?: number;
  }>;
  connectors?: Array<{
    ref: string;
    edge: "minX" | "maxX" | "minY" | "maxY";
    x: number;
    y: number;
    widthMm: number;
    heightMm: number;
    bounds?: { minX: number; minY: number; maxX: number; maxY: number };
  }>;
  components?: Array<{
    ref: string;
    x: number;
    y: number;
    heightMm: number;
    bottom: boolean;
    bounds: { minX: number; minY: number; maxX: number; maxY: number };
  }>;
};
/** Keep a centre-mounted gizmo while design/export coordinates retain the PCB's native origin. */
export function enclosureBoardPose(
  placement: MechanicalDesign["boards"][number],
  outline: EnclosureBoardSummary["outline"],
) {
  const cx = (outline.minX + outline.maxX) / 2,
    cy = (outline.minY + outline.maxY) / 2;
  const angle = (placement.rotation * Math.PI) / 180;
  return {
    origin: [cx, cy, 0] as [number, number, number],
    position: [
      placement.x + cx * Math.cos(angle) - cy * Math.sin(angle),
      placement.y + cx * Math.sin(angle) + cy * Math.cos(angle),
      placement.z,
    ] as [number, number, number],
    rotation: [0, 0, placement.rotation] as [number, number, number],
  };
}
export function enclosureBoardPlacement(
  placement: MechanicalDesign["boards"][number],
  outline: EnclosureBoardSummary["outline"],
  position: [number, number, number],
  rotation: number,
) {
  if (![...position, rotation].every(Number.isFinite))
    throw new Error("Enter a valid board position.");
  const offset = enclosureBoardPose({ ...placement, x: 0, y: 0, z: 0, rotation }, outline).position;
  return {
    ...placement,
    x: position[0] - offset[0],
    y: position[1] - offset[1],
    z: position[2],
    rotation,
  };
}
export function centerEnclosureBoard(
  placement: MechanicalDesign["boards"][number],
  outline: EnclosureBoardSummary["outline"],
  space: MechanicalDesign["space"],
) {
  // A placement aid, not a fit guarantee. Preserve height and orientation for mounting alignment.
  return enclosureBoardPlacement(
    placement,
    outline,
    [space.x + space.width / 2, space.y + space.depth / 2, placement.z],
    placement.rotation,
  );
}
/** Numeric placement and viewport handles use the same centre pivot and world coordinates. */
export function editEnclosureBoardPose(
  placement: MechanicalDesign["boards"][number],
  outline: EnclosureBoardSummary["outline"],
  field: "x" | "y" | "z" | "rotation",
  value: number,
) {
  const pose = enclosureBoardPose(placement, outline);
  if (field !== "rotation") pose.position[{ x: 0, y: 1, z: 2 }[field]] = value;
  return enclosureBoardPlacement(
    placement,
    outline,
    pose.position,
    field === "rotation" ? value : placement.rotation,
  );
}
export function defaultEnclosureDesign(board: EnclosureBoardSummary | null): MechanicalDesign {
  const o = board?.outline;
  const parts = board?.components ?? [];
  const clearance = 1,
    floor = 2;
  const boardZ =
    floor + Math.max(3, ...parts.filter((p) => p.bottom).map((p) => p.heightMm + clearance));
  const minX = o ? Math.min(o.minX, ...parts.map((p) => p.bounds.minX)) - 2 : 0;
  const minY = o ? Math.min(o.minY, ...parts.map((p) => p.bounds.minY)) - 2 : 0;
  const maxX = o ? Math.max(o.maxX, ...parts.map((p) => p.bounds.maxX)) + 2 : 100;
  const maxY = o ? Math.max(o.maxY, ...parts.map((p) => p.bounds.maxY)) + 2 : 70;
  return {
    version: 1,
    mode: "generated",
    confirmed: false,
    source: null,
    space: {
      x: minX,
      y: minY,
      width: maxX - minX,
      depth: maxY - minY,
      height: Math.max(
        20,
        boardZ -
          floor +
          (board?.thicknessMm ?? 1.6) +
          Math.max(0, ...parts.filter((p) => !p.bottom).map((p) => p.heightMm)) +
          clearance,
      ),
      wall: 2,
      floor,
      lid: 2,
      clearance,
    },
    boards: board ? [{ path: "board.kicad_pcb", x: 0, y: 0, z: boardZ, rotation: 0 }] : [],
    obstacles: [],
    openings:
      board?.connectors?.map((c) => ({
        name: c.ref,
        wall: c.edge,
        offset: c.bounds
          ? c.edge.endsWith("X")
            ? (c.bounds.minY + c.bounds.maxY) / 2
            : (c.bounds.minX + c.bounds.maxX) / 2
          : c.edge.endsWith("X")
            ? c.y
            : c.x,
        z: parts.find((p) => p.ref === c.ref)?.bottom
          ? boardZ - c.heightMm - clearance
          : boardZ + board.thicknessMm - clearance,
        width: c.widthMm + clearance * 2,
        height: c.heightMm + clearance * 2,
      })) ?? [],
    mounts:
      board?.holes
        // Connector alignment/pin holes are not screw mounts. Keep them in the PCB geometry.
        .filter(
          (h) =>
            h.shape !== "slot" &&
            (h.purpose ? h.purpose === "mounting" : !h.ref || !parts.some((p) => p.ref === h.ref)),
        )
        .map((h) => ({
          x: h.x,
          y: h.y,
          diameter: h.diameterMm,
          outer: h.diameterMm + 2.4,
          height: boardZ - floor,
          ...(h.id ? { boardPath: "board.kicad_pcb", holeId: h.id } : {}),
        })) ?? [],
  };
}
export function decodeMesh(base64: string): ArrayBuffer {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer;
}
export function validateEnclosureFile(name: string, bytes: number) {
  if (!/\.(stl|step|stp)$/i.test(name)) throw new Error("Choose an STL or STEP enclosure file.");
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > 50 * 1024 * 1024)
    throw new Error("Choose an enclosure between 1 byte and 50 MiB.");
}
export function enclosureFileLabel(path: string): string {
  return (path.split("/").at(-1) ?? path).replace(
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}-/i,
    "",
  );
}
export function enclosureErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "issues" in error && Array.isArray(error.issues)) {
    const first = error.issues[0] as { path?: unknown[]; message?: string } | undefined;
    return `Check ${first?.path?.join(" → ") || "enclosure settings"}: ${first?.message || "enter a valid value"}`;
  }
  let message = error instanceof Error ? error.message : String(error);
  if (
    error &&
    typeof error === "object" &&
    "rawMessage" in error &&
    typeof error.rawMessage === "string"
  ) {
    try {
      const raw = JSON.parse(error.rawMessage);
      if (typeof raw.error === "string") message = raw.error;
    } catch {
      /* Use the transport's readable fallback. */
    }
  }
  if (message.includes("PCB bridge unreachable"))
    return "The PCB editing service is not connected. Connect the FabPlane PCB backend before editing the board. Your saved PCB was preserved.";
  return message;
}
