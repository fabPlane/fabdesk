import type { MechanicalDesign } from "@fabdesk/protocol";

export type EnclosureBoardSummary = {
  pcbRevision: string;
  thicknessMm: number;
  outline: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    widthMm: number;
    heightMm: number;
  };
  holes: Array<{ x: number; y: number; diameterMm: number }>;
  connectors?: Array<{
    ref: string;
    edge: "minX" | "maxX" | "minY" | "maxY";
    x: number;
    y: number;
    widthMm: number;
    heightMm: number;
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
export function defaultEnclosureDesign(board: EnclosureBoardSummary | null): MechanicalDesign {
  const o = board?.outline;
  return {
    version: 1,
    mode: "generated",
    confirmed: false,
    source: null,
    space: {
      x: o ? o.minX - 2 : 0,
      y: o ? o.minY - 2 : 0,
      width: o ? o.widthMm + 4 : 100,
      depth: o ? o.heightMm + 4 : 70,
      height: Math.max(20, ...(board?.components?.map((c) => c.heightMm + 8) ?? [])),
      wall: 2,
      floor: 2,
      lid: 2,
      clearance: 1,
    },
    boards: board ? [{ path: "board.kicad_pcb", x: 0, y: 0, z: 5, rotation: 0 }] : [],
    obstacles: [],
    openings:
      board?.connectors?.map((c) => ({
        name: c.ref,
        wall: c.edge,
        offset: c.edge.endsWith("X") ? c.y : c.x,
        z: 5 + board.thicknessMm - 0.4,
        width: c.widthMm + 0.8,
        height: c.heightMm + 0.8,
      })) ?? [],
    mounts:
      board?.holes.map((h) => ({
        x: h.x,
        y: h.y,
        diameter: h.diameterMm,
        outer: h.diameterMm + 2.4,
        height: 3,
      })) ?? [],
  };
}
export function decodeMesh(base64: string): ArrayBuffer {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer;
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
